// ═══════════════════════════════════════════════════════════════════════════
//  APEX SIGNAL BOT v4 — TradingView Webhook → Telegram
//  Strategien: 4-Confirm Scalp · Daily Bias · NYC Opening Range · Multi-TF
//  Swing (1H) wird aus dem 1M-Feed gebaut · Auto Win/Loss · Persistenz
// ═══════════════════════════════════════════════════════════════════════════
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const broker = require('./broker'); // MetaApi (MT5) Ausführungs-Schicht

const TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID || "-5280319758";

// ─── KONFIGURATION ───────────────────────────────────────────────────────────
const CONFIG = {
  // ── SL/TP (× ATR) ──
  SL_MULT: 1.3,
  TP1_MULT: 1.3,
  TP2_MULT: 2.6,
  TP3_MULT: 4.0,
  BREAKEVEN_AFTER_TP2: true,
  // ── SL-Management: BE bei Mitte TP1↔TP2, danach Trailing ab TP2 ──
  BE_AT_TP1_TP2_MID: true,   // SL auf Break-Even, sobald Preis die Mitte TP1↔TP2 erreicht
  TRAIL_AFTER_TP2: true,     // ab TP2 den SL mit dem Kurs mitziehen (Ratsche)
  TRAIL_ATR_MULT: 1.5,       // Trailing-Abstand = 1.5 × ATR hinter dem Kurs

  MAX_CANDLES: 6500,   // hoch genug für 4H-Trend (26×240) & 1H-Liquidität — sonst nie A/B-Grades
  // Opening-Range-Breakout (15:45) — standardmäßig AUS (~20% Trefferquote, verlässlich rot).
  // Zum Wieder-Anschalten: Railway-Env ENABLE_OPENING_RANGE=true setzen.
  ENABLE_OPENING_RANGE: process.env.ENABLE_OPENING_RANGE === 'true',
  TRADE_TIMEOUT_MIN: 240, // 4h
  RSI_BUY: [45, 65],
  RSI_SELL: [35, 55],

  // ── Qualitäts-Filter ──
  REQUIRE_EMA_CROSS: false,  // false = EMA-Zustand statt Cross-Ereignis (deutlich mehr Signale)
  COOLDOWN_MIN: 0,           // 0 = kein Cooldown (nur 1 offener Trade pro Symbol begrenzt)
  MIN_ATR_PERCENT: 0.04,
  REQUIRE_BIAS_ALIGN: true,

  // ── Asia-Session-Filter (02:00–09:00 Berlin) ──
  ASIA_START_MIN: 2 * 60,
  ASIA_END_MIN: 9 * 60,
  ASIA_MIN_ATR_PERCENT: 0.07,
  ASIA_RSI_BUY: [50, 62],
  ASIA_RSI_SELL: [38, 50],

  // ── Abend-Filter (ab 19:00 Berlin) ──
  EVENING_START_MIN: 19 * 60,
  EVENING_END_MIN: 23 * 60,
  EVENING_MIN_ATR_PERCENT: 0.08,
  EVENING_RSI_BUY: [52, 62],
  EVENING_RSI_SELL: [38, 48],

  // ── Swing (1H) ──
  SWING_SL_MULT: 1.2,
  SWING_TP1_MULT: 1.0,
  SWING_TP2_MULT: 2.0,
  SWING_TP3_MULT: 3.0,
  SWING_TIMEOUT_MIN: 1440,
  SWING_EMA_FAST: 50,
  SWING_EMA_SLOW: 100,   // von 200 → 100: schnellerer Warmup (~1 Woche Marktzeit)
  SWING_PULLBACK_EMA: 20,
};

// ── Symbol-spezifische Filter-Überschreibungen ──
const SYMBOL_FILTERS = {
  'NDX': {
    minAtrPercent: 0.10,
    rsiBuy: [50, 62],
    rsiSell: [38, 50],
    cooldownMin: 0,
    requireBiasAlign: true,
    require15mAlign: false,
    require4hAlign: false,
    require5mAlign: true,
    requireBOS: false,
    requireLiquidity: false,
    sweepBoost: true,
  },
  'XAUUSD': {
    minAtrPercent: CONFIG.MIN_ATR_PERCENT,
    rsiBuy: CONFIG.RSI_BUY,
    rsiSell: CONFIG.RSI_SELL,
    cooldownMin: CONFIG.COOLDOWN_MIN,
    requireBiasAlign: CONFIG.REQUIRE_BIAS_ALIGN,
    require15mAlign: false,
    require4hAlign: false,
    require5mAlign: true,
    requireBOS: false,
    requireLiquidity: false,
    sweepBoost: true,
  },
};
function getFilters(sessionKey) {
  return SYMBOL_FILTERS[sessionKey] || SYMBOL_FILTERS['XAUUSD'];
}

// ── Pip- & Geldwert-Definitionen pro Symbol ──
// Gold: 1 Pip = 0.1 Preis-Einheiten. NASDAQ: 1 Pip = 1 Punkt.
const PIP_INFO = {
  'XAUUSD': { pipSize: 0.1 },
  'NDX':    { pipSize: 1.0 },
};
// EUR pro 1.0 Preis-Einheit pro 1.0 Lot — aus echten Vantage-Fills abgeleitet.
// (Gold: 9.92 Preis × 1 Lot = 866€ → 87 · NAS: 83.4 Pkt × 13.7 Lot = 997€ → 0.87)
const EUR_PER_PRICE_UNIT = {
  'XAUUSD': parseFloat(process.env.EUR_PER_PRICE_XAUUSD || '87'),
  'NDX':    parseFloat(process.env.EUR_PER_PRICE_NDX    || '0.87'),
};
// Fallback-Lot, wenn ein Trade (noch) keine echte Broker-Lot hat
const FALLBACK_LOT = {
  'XAUUSD': parseFloat(process.env.LOT_XAUUSD || '1'),
  'NDX':    parseFloat(process.env.LOT_NDX    || '1'),
};

// Wandelt eine Preis-Differenz in Pips + echten EUR-Wert um.
// lot = tatsächliche Broker-Lot des Trades (Swing wird risiko-basiert dimensioniert!)
function toPipsAndMoney(sessionKey, priceDiff, lot) {
  const info = PIP_INFO[sessionKey] || { pipSize: 1 };
  const l = (lot != null && lot > 0) ? lot : (FALLBACK_LOT[sessionKey] || 1);
  const pips = priceDiff / info.pipSize;
  const money = priceDiff * (EUR_PER_PRICE_UNIT[sessionKey] || 1) * l;
  return { pips, money };
}

// Formatiert PnL als "+12.5 Pips (+1.250 €)"
function fmtPnl(sessionKey, priceDiff, lot) {
  const { pips, money } = toPipsAndMoney(sessionKey, priceDiff, lot);
  const sign = priceDiff >= 0 ? '+' : '';
  return `${sign}${pips.toFixed(1)} Pips (${sign}${money.toFixed(0)} €)`;
}

// ─── MATH HELPERS ─────────────────────────────────────────────────────────────
function sma(a, n) { if (a.length < n) return null; return a.slice(-n).reduce((x, y) => x + y, 0) / n; }
function ema(a, n) {
  if (a.length < n) return null;
  const k = 2 / (n + 1);
  let e = a.slice(0, n).reduce((x, y) => x + y, 0) / n;
  for (let i = n; i < a.length; i++) e = a[i] * k + e * (1 - k);
  return e;
}
function rsiCalc(a, n = 14) {
  if (a.length < n + 1) return null;
  const ch = a.slice(-n - 1).map((p, i, arr) => i > 0 ? p - arr[i - 1] : 0).slice(1);
  const ag = ch.filter(c => c > 0).reduce((x, y) => x + y, 0) / n;
  const al = ch.filter(c => c < 0).map(c => -c).reduce((x, y) => x + y, 0) / n;
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}
function macdL(a) { const e12 = ema(a, 12), e26 = ema(a, 26); return (e12 !== null && e26 !== null) ? e12 - e26 : null; }
function atrCalc(closes, highs, lows, n = 14) {
  if (closes.length < n + 1) return null;
  let sum = 0, count = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    if (i < 1) continue;
    const h = highs[i], l = lows[i], pc = closes[i - 1];
    sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    count++;
  }
  return count > 0 ? sum / count : null;
}

// ─── MULTI-TIMEFRAME (1M → 15M) ────────────────────────────────────────────────
function aggregateTo15M(closes, highs, lows) {
  return aggregateTF(closes, highs, lows, 15);
}
function aggregateTF(closes, highs, lows, size) {
  const out = { closes: [], highs: [], lows: [] };
  for (let i = 0; i + size <= closes.length; i += size) {
    out.closes.push(closes[i + size - 1]);
    out.highs.push(Math.max(...highs.slice(i, i + size)));
    out.lows.push(Math.min(...lows.slice(i, i + size)));
  }
  return out;
}
function get15MTrend(closes, highs, lows) {
  const tf = aggregateTo15M(closes, highs, lows);
  if (tf.closes.length < 26) return null;
  const e12 = ema(tf.closes, 12), e26 = ema(tf.closes, 26);
  if (e12 === null || e26 === null) return null;
  return e12 > e26 ? 'BUY' : 'SELL';
}
function getTrendOnTF(closes, highs, lows, size) {
  const tf = aggregateTF(closes, highs, lows, size);
  if (tf.closes.length < 26) return null;
  const e12 = ema(tf.closes, 12), e26 = ema(tf.closes, 26);
  if (e12 === null || e26 === null) return null;
  return e12 > e26 ? 'BUY' : 'SELL';
}
function get5MTrend(closes, highs, lows) {
  const tf = aggregateTF(closes, highs, lows, 5);
  if (tf.closes.length < 21) return null;
  const e9 = ema(tf.closes, 9), e21 = ema(tf.closes, 21);
  if (e9 === null || e21 === null) return null;
  return e9 > e21 ? 'BUY' : 'SELL';
}

// ─── LIQUIDITÄT (1H Swing-Highs/Lows als Annäherung) ──────────────────────────
function findLiquidity(closes, highs, lows) {
  const h1 = aggregateTF(closes, highs, lows, 60);
  if (h1.closes.length < 10) return null;
  const cur = closes[closes.length - 1];
  const lookback = Math.min(20, h1.highs.length);
  const recentHighs = h1.highs.slice(-lookback);
  const recentLows = h1.lows.slice(-lookback);
  const liqAbove = recentHighs.filter(h => h > cur).sort((a, b) => a - b)[0] || null;
  const liqBelow = recentLows.filter(l => l < cur).sort((a, b) => b - a)[0] || null;
  return { liqAbove, liqBelow, cur };
}

// ─── BREAK OF STRUCTURE (vereinfacht) ─────────────────────────────────────────
function breakOfStructure(closes, highs, lows) {
  const tf = aggregateTF(closes, highs, lows, 15);
  if (tf.closes.length < 8) return null;
  const cur = tf.closes[tf.closes.length - 1];
  const prevHighs = tf.highs.slice(-7, -1);
  const prevLows = tf.lows.slice(-7, -1);
  const lastSwingHigh = Math.max(...prevHighs);
  const lastSwingLow = Math.min(...prevLows);
  if (cur > lastSwingHigh) return 'BUY';
  if (cur < lastSwingLow) return 'SELL';
  return null;
}

// ─── LIQUIDITY SWEEP / STOP-HUNT (ICT-Konzept) ────────────────────────────────
function liquiditySweep(closes, highs, lows) {
  const tf = aggregateTF(closes, highs, lows, 15);
  if (tf.closes.length < 6) return null;
  const n = tf.closes.length;
  const curHigh = tf.highs[n - 1];
  const curLow = tf.lows[n - 1];
  const curClose = tf.closes[n - 1];
  const refHighs = tf.highs.slice(-6, -1);
  const refLows = tf.lows.slice(-6, -1);
  if (refHighs.length < 5) return null;
  const prevHigh = Math.max(...refHighs);
  const prevLow = Math.min(...refLows);
  if (curLow < prevLow && curClose > prevLow) return 'BUY';
  if (curHigh > prevHigh && curClose < prevHigh) return 'SELL';
  return null;
}

// ─── FAIR VALUE GAP (FVG) ─────────────────────────────────────────────────────
function detectFVG(closes, highs, lows, signal) {
  const tf = aggregateTF(closes, highs, lows, 5);
  const n = tf.closes.length;
  if (n < 3) return false;
  const h = tf.highs, l = tf.lows;
  const bullFVG = l[n - 1] > h[n - 3];
  const bearFVG = h[n - 1] < l[n - 3];
  if (signal === 'BUY') return bullFVG;
  if (signal === 'SELL') return bearFVG;
  return false;
}

// ─── KERZEN-STÄRKE ("Volume"-Annäherung) ──────────────────────────────────────
function bodyStrength(closes, highs, lows) {
  const n = closes.length;
  if (n < 2) return 0;
  const open = closes[n - 2];
  const close = closes[n - 1];
  const high = highs[n - 1];
  const low = lows[n - 1];
  const range = high - low;
  if (range <= 0) return 0;
  return Math.abs(close - open) / range;
}

// ─── STRATEGIE: 4-Confirm Conservative Scalp ───────────────────────────────────
function runStrategy(closes, highs, lows, sessionKey) {
  if (closes.length < 70) return null;
  const cur = closes[closes.length - 1];
  const prev = closes.slice(0, -1);

  const filt = getFilters(sessionKey);

  const tNow = berlinMinutesOfDay();
  const isAsia = tNow >= CONFIG.ASIA_START_MIN && tNow < CONFIG.ASIA_END_MIN;
  const isEvening = tNow >= CONFIG.EVENING_START_MIN && tNow < CONFIG.EVENING_END_MIN;

  const e12n = ema(closes, 12), e26n = ema(closes, 26);
  const e12p = ema(prev, 12), e26p = ema(prev, 26);
  if ([e12n, e26n, e12p, e26p].some(v => v === null)) return null;

  const crossUp = e12p <= e26p && e12n > e26n;
  const crossDown = e12p >= e26p && e12n < e26n;

  // Gelockerte Variante: EMA-ZUSTAND statt Cross-Ereignis.
  // REQUIRE_EMA_CROSS=true  → nur exakt in der Cross-Minute (sehr selten)
  // REQUIRE_EMA_CROSS=false → immer wenn EMA12 über/unter EMA26 liegt (viel mehr Signale)
  const emaBull = CONFIG.REQUIRE_EMA_CROSS ? crossUp   : (e12n > e26n);
  const emaBear = CONFIG.REQUIRE_EMA_CROSS ? crossDown : (e12n < e26n);

  const rv = rsiCalc(closes);
  if (rv === null) return null;
  let rsiBuyRange = filt.rsiBuy, rsiSellRange = filt.rsiSell;
  if (isAsia) { rsiBuyRange = CONFIG.ASIA_RSI_BUY; rsiSellRange = CONFIG.ASIA_RSI_SELL; }
  else if (isEvening) { rsiBuyRange = CONFIG.EVENING_RSI_BUY; rsiSellRange = CONFIG.EVENING_RSI_SELL; }
  const rsiBuy = rv >= rsiBuyRange[0] && rv <= rsiBuyRange[1];
  const rsiSell = rv >= rsiSellRange[0] && rv <= rsiSellRange[1];

  const mn = macdL(closes), mp = macdL(prev);
  if (mn === null || mp === null) return null;
  const mBull = mn > 0 && mn > mp;
  const mBear = mn < 0 && mn < mp;

  const s50 = sma(closes, 50);
  if (s50 === null) return null;

  const atrV = atrCalc(closes, highs, lows) || cur * 0.005;

  const atrPercent = (atrV / cur) * 100;
  let minAtr = filt.minAtrPercent;
  if (isAsia) minAtr = Math.max(CONFIG.ASIA_MIN_ATR_PERCENT, filt.minAtrPercent);
  else if (isEvening) minAtr = Math.max(CONFIG.EVENING_MIN_ATR_PERCENT, filt.minAtrPercent);
  if (atrPercent < minAtr) return null;

  const buyS = emaBull && rsiBuy && mBull && cur > s50;
  const sellS = emaBear && rsiSell && mBear && cur < s50;
  if (!buyS && !sellS) return null;

  const signal = buyS ? 'BUY' : 'SELL';

  if (filt.require15mAlign) {
    const t15 = get15MTrend(closes, highs, lows);
    if (t15 && t15 !== signal) return null;
  }
  if (filt.require4hAlign) {
    const t4h = getTrendOnTF(closes, highs, lows, 240);
    if (t4h && t4h !== signal) return null;
  }
  if (filt.require5mAlign) {
    const t5 = get5MTrend(closes, highs, lows);
    if (t5 && t5 !== signal) return null;
  }
  if (filt.requireBOS) {
    const bos = breakOfStructure(closes, highs, lows);
    if (bos && bos !== signal) return null;
  }
  let liqInfo = null;
  if (filt.requireLiquidity) {
    const liq = findLiquidity(closes, highs, lows);
    if (liq) {
      liqInfo = liq;
      if (signal === 'BUY' && liq.liqAbove === null) return null;
      if (signal === 'SELL' && liq.liqBelow === null) return null;
    }
  }

  let sweptLiquidity = false;
  if (filt.sweepBoost) {
    const sweep = liquiditySweep(closes, highs, lows);
    if (sweep === signal) sweptLiquidity = true;
  }

  const dir = buyS ? 1 : -1;
  const sl = parseFloat((cur - dir * atrV * CONFIG.SL_MULT).toFixed(2));
  const tp1 = parseFloat((cur + dir * atrV * CONFIG.TP1_MULT).toFixed(2));
  const tp2 = parseFloat((cur + dir * atrV * CONFIG.TP2_MULT).toFixed(2));
  const tp3 = parseFloat((cur + dir * atrV * CONFIG.TP3_MULT).toFixed(2));
  const rr = (CONFIG.TP1_MULT / CONFIG.SL_MULT).toFixed(2);

  const liqTarget = liqInfo
    ? (signal === 'BUY' ? liqInfo.liqAbove : liqInfo.liqBelow)
    : null;

  // 4H-Trend aus den 1H-Swing-Kerzen (×4) statt aus 6.240 Minuten-Kerzen —
  // sonst feuert dieser Faktor fast nie und A/A+ bleiben unerreichbar.
  const sw4h = swingStore[sessionKey];
  const t4hGrade = (sw4h && sw4h.closes.length >= 104)
    ? getTrendOnTF(sw4h.closes, sw4h.highs, sw4h.lows, 4)   // 4× 1H = 4H, braucht nur 26 Kerzen
    : getTrendOnTF(closes, highs, lows, 240);               // Fallback bis Swing-Store warm ist
  const t15Grade = get15MTrend(closes, highs, lows);
  const fvg = detectFVG(closes, highs, lows, signal);
  const lastBodyRatio = bodyStrength(closes, highs, lows);
  const strongCandle = lastBodyRatio >= 0.6;

  const factors = {
    sweep: sweptLiquidity,
    liquidity: !!liqTarget,
    biasAlign: !!(t4hGrade && t4hGrade === signal),
    entryAlign: !!(t15Grade && t15Grade === signal),
    fvg: fvg,
    strongCandle: strongCandle,
  };
  const score = Object.values(factors).filter(Boolean).length;
  let grade = 'C';
  if (score >= 5) grade = 'A+';
  else if (score === 4) grade = 'A';
  else if (score === 3) grade = 'B';

  return {
    signal,
    cur: parseFloat(cur.toFixed(2)),
    sl, tp1, tp2, tp3, rr,
    atr: atrV,
    rsi: rv.toFixed(1),
    macd: mn.toFixed(3),
    liqTarget: liqTarget ? parseFloat(liqTarget.toFixed(2)) : null,
    sweptLiquidity,
    grade, score, factors,
  };
}

// ─── SWING-STRATEGIE: Trend-Following mit Pullback (1H) ────────────────────────
function runSwingStrategy(closes, highs, lows) {
  const need = CONFIG.SWING_EMA_SLOW + 5;
  if (closes.length < need) return null;

  const cur = closes[closes.length - 1];
  const emaFast = ema(closes, CONFIG.SWING_EMA_FAST);
  const emaSlow = ema(closes, CONFIG.SWING_EMA_SLOW);
  const emaPull = ema(closes, CONFIG.SWING_PULLBACK_EMA);
  if ([emaFast, emaSlow, emaPull].some(v => v === null)) return null;

  const rv = rsiCalc(closes);
  if (rv === null) return null;

  const atrV = atrCalc(closes, highs, lows) || cur * 0.005;

  const uptrend = emaFast > emaSlow;
  const downtrend = emaFast < emaSlow;
  const nearPullback = Math.abs(cur - emaPull) <= atrV * 0.5;

  const buy = uptrend && nearPullback && cur > emaPull && rv > 45 && rv < 70;
  const sell = downtrend && nearPullback && cur < emaPull && rv < 55 && rv > 30;
  if (!buy && !sell) return null;

  const signal = buy ? 'BUY' : 'SELL';
  const dir = buy ? 1 : -1;
  const sl = parseFloat((cur - dir * atrV * CONFIG.SWING_SL_MULT).toFixed(2));
  const tp1 = parseFloat((cur + dir * atrV * CONFIG.SWING_TP1_MULT).toFixed(2));
  const tp2 = parseFloat((cur + dir * atrV * CONFIG.SWING_TP2_MULT).toFixed(2));
  const tp3 = parseFloat((cur + dir * atrV * CONFIG.SWING_TP3_MULT).toFixed(2));
  const rr = (CONFIG.SWING_TP1_MULT / CONFIG.SWING_SL_MULT).toFixed(2);

  return {
    signal,
    cur: parseFloat(cur.toFixed(2)),
    sl, tp1, tp2, tp3, rr,
    atr: atrV,
    rsi: rv.toFixed(1),
    trend: uptrend ? 'Aufwärtstrend' : 'Abwärtstrend',
  };
}

// ─── ZEIT (Berlin) ──────────────────────────────────────────────────────────
function berlinParts() {
  const s = new Date().toLocaleString('en-GB', { timeZone: 'Europe/Berlin', hour12: false, hour: '2-digit', minute: '2-digit' });
  const [h, m] = s.split(':').map(x => parseInt(x, 10));
  return { hour: h, min: m };
}
function getBerlinDate() { return new Date().toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' }); }
function getBerlinTime() { return new Date().toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' }); }
function berlinMinutesOfDay() { const { hour, min } = berlinParts(); return hour * 60 + min; }

const T = {
  MORNING: 8 * 60,
  ASIA_START: 2 * 60,
  ASIA_END: 9 * 60,
  LONDON_END: 15 * 60 + 30,
  NYC_OPEN: 15 * 60 + 30,
  RANGE_END: 15 * 60 + 45,
  NYC_CLOSE: 22 * 60,
  REPORT: 22 * 60,
};

// ─── SESSION STATE ────────────────────────────────────────────────────────────
function freshSession() {
  return {
    date: null,
    asiaHigh: null, asiaLow: null,
    londonBrokeHigh: false, londonBrokeLow: false,
    biasSent: false, lastBias: null,
    openingRange: { high: null, low: null, sent: false, breakoutSent: false },
    reportSent: false,
    performance: { wins: 0, losses: 0, trades: [], streak: 0, streakType: null, bestStreak: 0, worstStreak: 0 },
  };
}
const sessionData = { 'XAUUSD': freshSession(), 'NDX': freshSession() };

const dailyFlags = { date: null, morningSent: false, asiaPinged: false, londonPinged: false, nyPinged: false };
function resetDailyFlagsIfNeeded() {
  const today = getBerlinDate();
  if (dailyFlags.date !== today) {
    dailyFlags.date = today;
    dailyFlags.morningSent = false;
    dailyFlags.asiaPinged = false;
    dailyFlags.londonPinged = false;
    dailyFlags.nyPinged = false;
  }
}

function resetDayIfNeeded(sd) {
  const today = getBerlinDate();
  if (sd.date !== today) {
    Object.assign(sd, freshSession());
    sd.date = today;
    console.log(`🔄 Day reset für ${today}`);
  }
}

function updateSessions(sd, high, low) {
  const t = berlinMinutesOfDay();
  if (t >= T.ASIA_START && t < T.ASIA_END) {
    if (sd.asiaHigh === null || high > sd.asiaHigh) sd.asiaHigh = high;
    if (sd.asiaLow === null || low < sd.asiaLow) sd.asiaLow = low;
  }
  if (t >= T.ASIA_END && t < T.LONDON_END) {
    if (sd.asiaHigh !== null && high > sd.asiaHigh) sd.londonBrokeHigh = true;
    if (sd.asiaLow !== null && low < sd.asiaLow) sd.londonBrokeLow = true;
  }
  if (t >= T.NYC_OPEN && t < T.RANGE_END) {
    if (sd.openingRange.high === null || high > sd.openingRange.high) sd.openingRange.high = high;
    if (sd.openingRange.low === null || low < sd.openingRange.low) sd.openingRange.low = low;
  }
}

function calcDailyBias(sd) {
  if (sd.asiaHigh === null || sd.asiaLow === null) return null;
  let bias, reason;
  if (sd.londonBrokeHigh && !sd.londonBrokeLow) {
    bias = 'SELL'; reason = 'London hat das Asia-High geholt aber keinen Uptrend gehalten → NYC drückt nach unten 📉';
  } else if (!sd.londonBrokeHigh && sd.londonBrokeLow) {
    bias = 'BUY'; reason = 'London hat das Asia-Low geholt aber keinen Downtrend gehalten → NYC dreht nach oben 📈';
  } else if (!sd.londonBrokeHigh && !sd.londonBrokeLow) {
    bias = 'WATCH'; reason = 'London hat weder High noch Low geholt → NYC manipuliert zuerst, dann Reversal ⚠️';
  } else {
    bias = 'NEUTRAL'; reason = 'London hat beide Seiten gebrochen → heute kein klarer Bias';
  }
  return { bias, reason, asiaHigh: sd.asiaHigh, asiaLow: sd.asiaLow };
}

function checkOpeningRangeBreakout(sd, close) {
  if (sd.openingRange.high === null || sd.openingRange.low === null) return null;
  if (berlinMinutesOfDay() < T.RANGE_END) return null;
  if (close > sd.openingRange.high) return 'BUY';
  if (close < sd.openingRange.low) return 'SELL';
  return null;
}

// ─── PERFORMANCE ──────────────────────────────────────────────────────────────
function recordTrade(sd, trade, result, pnl) {
  if (result === 'WIN') {
    sd.performance.wins++;
    if (sd.performance.streakType === 'WIN') sd.performance.streak++;
    else { sd.performance.streak = 1; sd.performance.streakType = 'WIN'; }
    if (sd.performance.streak > sd.performance.bestStreak) sd.performance.bestStreak = sd.performance.streak;
  } else if (result === 'LOSS') {
    sd.performance.losses++;
    if (sd.performance.streakType === 'LOSS') sd.performance.streak++;
    else { sd.performance.streak = 1; sd.performance.streakType = 'LOSS'; }
    if (sd.performance.streak > sd.performance.worstStreak) sd.performance.worstStreak = sd.performance.streak;
  }
  sd.performance.trades.push({ signal: trade.signal, entry: trade.entry, result, pnl, lot: trade.lot, time: getBerlinTime() });
}

// ─── OPEN TRADES TRACKER ────────────────────────────────────────────────────
const openTrades = [];
const signalLog = [];
function logSignal(entry) {
  signalLog.unshift(entry);
  if (signalLog.length > 30) signalLog.pop();
}
const lastTradeTime = {};

// ── Dauerhafte Trade-Historie (persistiert) — Basis für die Weekly Summary ──
const tradeHistory = [];
const weeklyReport = { lastSent: null };  // Datum des letzten Freitag-Reports

// Wochentag (0=So … 5=Fr, 6=Sa) in Berlin-Zeit
function berlinWeekday() {
  const s = new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin', weekday: 'short' });
  return ({ Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 })[s.slice(0,3)] ?? 0;
}

// Einen abgeschlossenen Trade dauerhaft in die Historie schreiben
function logHistory(trade, exitPrice, reason) {
  const sessionKey = getSessionKey(trade.symbol);
  const dir = trade.signal === 'BUY' ? 1 : -1;
  const priceDiff = (exitPrice - trade.entry) * dir;
  const { pips, money } = toPipsAndMoney(sessionKey, priceDiff, trade.lot);
  tradeHistory.push({
    ts: Date.now(),
    date: getBerlinDate(),
    weekday: berlinWeekday(),
    symbol: getAssetLabel(trade.symbol),
    signal: trade.signal,
    type: trade.type,                 // '4confirm' | 'swing' | 'opening_range'
    grade: trade.grade || null,       // nur Scalp hat ein Grade
    entry: trade.entry,
    exit: parseFloat(Number(exitPrice).toFixed(2)),
    reason,                           // 'TP3' | 'Trailing' | 'BE' | 'SL' | 'Timeout'
    result: money > 1 ? 'WIN' : (money < -1 ? 'LOSS' : 'BE'),
    pnl: parseFloat(money.toFixed(1)),
    pips: parseFloat(pips.toFixed(1)),
    lot: trade.lot || null,
  });
  if (tradeHistory.length > 3000) tradeHistory.shift();
}

// Bucht einen abgeschlossenen Trade EINMAL — beim echten Positions-Schluss — für
// Dashboard-Statistik UND persistente Historie aus derselben Quelle. So zeigen beide
// denselben, vollen Gewinn (TP3/Trailing), statt nur den TP1-Teilbetrag.
function recordClose(trade, exitPrice, reason) {
  const sessionKey = getSessionKey(trade.symbol);
  const sd = sessionKey ? sessionData[sessionKey] : null;
  const dir = trade.signal === 'BUY' ? 1 : -1;
  const priceDiff = (exitPrice - trade.entry) * dir;              // Preis-Differenz (Dashboard-Konvention)
  const { pips, money } = toPipsAndMoney(sessionKey, priceDiff, trade.lot);
  const result = money > 1 ? 'WIN' : (money < -1 ? 'LOSS' : 'BE');
  // Dashboard-Performance (nur WIN/LOSS zählen für Serie; BE ist neutral)
  if (sd) {
    if (result === 'WIN') {
      sd.performance.wins++;
      if (sd.performance.streakType === 'WIN') sd.performance.streak++; else { sd.performance.streak = 1; sd.performance.streakType = 'WIN'; }
      if (sd.performance.streak > sd.performance.bestStreak) sd.performance.bestStreak = sd.performance.streak;
    } else if (result === 'LOSS') {
      sd.performance.losses++;
      if (sd.performance.streakType === 'LOSS') sd.performance.streak++; else { sd.performance.streak = 1; sd.performance.streakType = 'LOSS'; }
      if (sd.performance.streak > sd.performance.worstStreak) sd.performance.worstStreak = sd.performance.streak;
    }
    sd.performance.trades.push({ signal: trade.signal, entry: trade.entry, result, pnl: parseFloat(priceDiff.toFixed(4)), lot: trade.lot, time: getBerlinTime() });
  }
  // Persistente Historie (Wochenreport) — identischer Exit
  tradeHistory.push({
    ts: Date.now(), date: getBerlinDate(), weekday: berlinWeekday(),
    symbol: getAssetLabel(trade.symbol), signal: trade.signal, type: trade.type,
    grade: trade.grade || null, entry: trade.entry, exit: parseFloat(Number(exitPrice).toFixed(2)),
    reason, result, pnl: parseFloat(money.toFixed(1)), pips: parseFloat(pips.toFixed(1)), lot: trade.lot || null,
  });
  if (tradeHistory.length > 3000) tradeHistory.shift();
}

function hasOpenTrade(symbol) {
  return openTrades.some(t => t.symbol === symbol);
}

function inCooldown(normSym) {
  const last = lastTradeTime[normSym];
  if (!last) return false;
  const sessionKey = getSessionKey(normSym);
  const cooldownMin = getFilters(sessionKey).cooldownMin || CONFIG.COOLDOWN_MIN;
  return (Date.now() - last) < cooldownMin * 60 * 1000;
}

// Übersetzt ein TradingView-Preislevel in das Broker-Preisniveau (gleicher Versatz
// wie beim Einstieg). So sitzen BE/Trailing beim Broker korrekt, trotz Preis-Versatz.
function brokerLevel(trade, tvLevel) {
  return (trade.brokerEntry != null) ? trade.brokerEntry + (tvLevel - trade.entry) : tvLevel;
}

async function checkOpenTrades(symbol, high, low) {
  const sessionKey = getSessionKey(symbol);
  const assetLabel = getAssetLabel(symbol);
  const sd = sessionKey ? sessionData[sessionKey] : null;
  const now = Date.now();
  const remaining = [];

  for (const trade of openTrades) {
    if (trade.symbol !== symbol) { remaining.push(trade); continue; }

    const isBuy = trade.signal === 'BUY';
    const tl = trade.type === 'opening_range' ? 'Range' : trade.type === 'swing' ? 'Swing' : 'Scalp';
    const reached = (level) => isBuy ? high >= level : low <= level;

    if (!trade.tp1Hit && reached(trade.tp1)) {
      trade.tp1Hit = true;
      await sendTelegram(`✅ *TP1 erreicht · ${assetLabel}* · ${fmtPnl(sessionKey, Math.abs(trade.tp1 - trade.entry), trade.lot)}
${trade.signal} ${tl} — SL wandert nach, Trade läuft weiter
Nächstes Ziel ${trade.tp2.toFixed(2)}`);
      console.log(`🎯 TP1 HIT: ${trade.signal} ${assetLabel}`);
    }

    // ── Break-Even, sobald der Preis die Mitte zwischen TP1 und TP2 erreicht ──
    if (CONFIG.BE_AT_TP1_TP2_MID && !trade.beMoved) {
      const beTrigger = (trade.tp1 + trade.tp2) / 2;
      if (reached(beTrigger)) {
        trade.beMoved = true;
        trade.sl = trade.entry;
        await broker.moveToBreakeven(trade.positionId, brokerLevel(trade, trade.entry), brokerLevel(trade, trade.tp3));
        await sendTelegram(`🔒 *Break-Even · ${assetLabel}*
SL auf Entry ${trade.entry.toFixed(2)} — läuft ab jetzt risikofrei`);
        console.log(`🛡 BE (Mitte TP1/TP2): ${trade.signal} ${assetLabel}`);
      }
    }

    // ── TP2: Trailing aktivieren ──
    if (trade.tp1Hit && !trade.tp2Hit && reached(trade.tp2)) {
      trade.tp2Hit = true;
      trade.trailing = CONFIG.TRAIL_AFTER_TP2;
      if (!trade.beMoved) { trade.beMoved = true; trade.sl = trade.entry; await broker.moveToBreakeven(trade.positionId, brokerLevel(trade, trade.entry), brokerLevel(trade, trade.tp3)); }
      await sendTelegram(`✅ *TP2 · ${assetLabel}* · ${fmtPnl(sessionKey, Math.abs(trade.tp2 - trade.entry), trade.lot)}
${trade.signal} ${tl}${CONFIG.TRAIL_AFTER_TP2 ? ` — Trailing aktiv (${CONFIG.TRAIL_ATR_MULT}×ATR)` : ''}
Letztes Ziel ${trade.tp3.toFixed(2)}`);
      console.log(`🎯 TP2 HIT: ${trade.signal} ${assetLabel} → Trailing an`);
    }

    // ── Trailing-Update (Ratsche): SL nur in Gewinnrichtung nachziehen ──
    if (trade.trailing && trade.atr) {
      const dist = trade.atr * CONFIG.TRAIL_ATR_MULT;
      const cand = parseFloat((isBuy ? high - dist : low + dist).toFixed(2));
      const better = isBuy ? cand > trade.sl : cand < trade.sl;
      if (better) {
        trade.sl = cand;
        await broker.modifyStop(trade.positionId, brokerLevel(trade, cand), brokerLevel(trade, trade.tp3));
        console.log(`📈 Trailing SL → ${cand} (${trade.signal} ${assetLabel})`);
      }
    }

    if (trade.tp2Hit && reached(trade.tp3)) {
      await sendTelegram(`🏆 *TP3 · ${assetLabel}* · ${fmtPnl(sessionKey, Math.abs(trade.tp3 - trade.entry), trade.lot)}
${trade.signal} ${tl} — voll durchgelaufen, Trade zu`);
      console.log(`🏆 TP3 HIT: ${trade.signal} ${assetLabel} — geschlossen`);
      recordClose(trade, trade.tp3, 'TP3');
      await broker.closeTrade(trade.positionId);
      continue;
    }

    const slHit = isBuy ? low <= trade.sl : high >= trade.sl;
    if (slHit) {
      const inProfit = isBuy ? trade.sl >= trade.entry : trade.sl <= trade.entry;
      if (inProfit && trade.tp1Hit) {
        // Break-Even- oder Trailing-Stop → Gewinn gesichert, kein Verlust
        const atBE = Math.abs(trade.sl - trade.entry) < 1e-9;
        const locked = Math.abs(trade.sl - trade.entry);
        await sendTelegram(`🛡 *${atBE ? 'Break-Even Stop' : 'Trailing Stop'} · ${assetLabel}*${atBE ? '' : ` · ${fmtPnl(sessionKey, locked, trade.lot)}`}
${trade.signal} ${tl} — zu bei ${trade.sl.toFixed(2)}
${atBE ? `Kein Verlust · Gewinn aus TP1${trade.tp2Hit ? '/TP2' : ''} gesichert` : 'Gewinn über Entry gesichert'}`);
        console.log(`🛡 ${atBE ? 'BE' : 'Trailing'} Stop: ${trade.signal} ${assetLabel}`);
        recordClose(trade, trade.sl, atBE ? 'BE' : 'Trailing');
      } else {
        recordClose(trade, trade.sl, 'SL');
        const total = sd ? sd.performance.wins + sd.performance.losses : 0;
        const winRate = total > 0 ? ((sd.performance.wins / total) * 100).toFixed(1) : '0';
        await sendTelegram(`❌ *Loss · ${assetLabel}* · ${fmtPnl(sessionKey, -Math.abs(trade.entry - trade.sl), trade.lot)}
${trade.signal} ${tl} — ${trade.entry.toFixed(2)} → ${trade.sl.toFixed(2)}
_Heute ${sd ? sd.performance.wins : 0}W/${sd ? sd.performance.losses : 0}L · ${winRate}% · Serie ${sd ? sd.performance.streak : 0}×_`);
        console.log(`❌ LOSS: ${trade.signal} ${assetLabel}`);
      }
      await broker.closeTrade(trade.positionId);
      continue;
    }

    const timeoutMin = trade.timeoutMin || CONFIG.TRADE_TIMEOUT_MIN;
    if ((now - trade.openedAt) > timeoutMin * 60 * 1000) {
      if (!trade.tp1Hit) {
        await sendTelegram(`⌛ *Timeout · ${assetLabel}*
${trade.signal} ${tl} — nach Zeitlimit zu (Entry war ${trade.entry.toFixed(2)})`);
        console.log(`⏱ TIMEOUT: ${trade.signal} ${assetLabel}`);
      }
      recordClose(trade, trade.entry, 'Timeout');
      await broker.closeTrade(trade.positionId);
      continue;
    }

    remaining.push(trade);
  }

  openTrades.length = 0;
  openTrades.push(...remaining);
}

// ─── TELEGRAM (robust) ────────────────────────────────────────────────────────
function sendTelegram(msg) {
  return new Promise((resolve) => {
    if (!TOKEN) { console.warn('⚠️ BOT_TOKEN fehlt — Nachricht nicht gesendet'); return resolve({ ok: false }); }
    const body = JSON.stringify({ chat_id: CHAT_ID, text: msg, parse_mode: 'Markdown' });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 10000,
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { console.error('❌ Telegram Antwort nicht lesbar:', data.slice(0, 100)); resolve({ ok: false }); }
      });
    });
    req.on('error', e => { console.error('❌ Telegram Fehler:', e.message); resolve({ ok: false }); });
    req.on('timeout', () => { req.destroy(); console.error('❌ Telegram Timeout'); resolve({ ok: false }); });
    req.write(body); req.end();
  });
}

// ─── NACHRICHTEN ──────────────────────────────────────────────────────────────
// ── Clean-Layout-Helfer ──────────────────────────────────────────────────────
function block(lines) { return '```\n' + lines.join('\n') + '\n```'; }
function prow(label, value, suffix) {
  const v = (typeof value === 'number') ? value.toFixed(2) : String(value);
  return label.padEnd(7) + v.padStart(11) + (suffix ? '  ' + suffix : '');
}
function rLabel(entry, sl, tp) {
  const risk = Math.abs(entry - sl);
  if (!risk) return '';
  return '+' + (Math.abs(tp - entry) / risk).toFixed(1) + 'R';
}
function biasLine(bias, signal) {
  if (!bias || bias === 'WATCH' || bias === 'NEUTRAL') return '';
  return bias === signal ? '\n✅ mit Daily Bias' : '\n⚠️ gegen Daily Bias';
}

function buildMorningMsg() {
  const events = ['Bias      15:30'];
  if (CONFIG.ENABLE_OPENING_RANGE) events.push('Range     15:45');
  events.push('Report    22:00');
  return `☀️ *Guten Morgen*
_${getBerlinDate()}_

📡 *Überwacht*
XAU/USD · NASDAQ 100
Scalp + Swing · Auto-Trading aktiv

🌍 *Handelszeiten* (Berlin)
${block([
  'Asia       02:00 – 09:00',
  'London     09:00 – 15:30',
  'New York   15:30 – 22:00',
])}
🕐 *Heute*
${block(events)}
_Apex_`;
}

// Kurzer Ping beim Start einer Handels-Session
function buildSessionMsg(flag, name, range) {
  return `${flag} *${name}-Session offen*
${range} Uhr (Berlin)
_Apex_`;
}

function buildBiasMsg(asset, bias, reason, asiaHigh, asiaLow) {
  const t = bias === 'BUY' ? 'Long 📈' : bias === 'SELL' ? 'Short 📉' : bias === 'WATCH' ? 'Watch 👀' : 'Neutral';
  return `🧭 *Daily Bias · ${asset}*
Richtung: *${t}*

${block([prow('Asia H', asiaHigh), prow('Asia L', asiaLow)])}
${reason}

_${getBerlinDate()} · Apex_`;
}

function buildOpeningRangeMsg(asset, high, low) {
  return `🎯 *Opening Range · ${asset}*

${block([prow('High', high), prow('Low', low), prow('Größe', high - low)])}
_Warte auf Ausbruch · ${getBerlinTime()}_`;
}

function buildOpeningRangeSignalMsg(signal, asset, entry, sl, tp1, tp2, tp3, rr, bias, trend15m, lot) {
  const emoji = signal === 'BUY' ? '🟢' : '🔴';
  const trend = trend15m ? (trend15m === signal ? '15M ✓' : '15M ✗') : '15M –';
  return `${emoji} *${signal} · ${asset}*
Range-Breakout${lot ? ` · ${lot} Lot` : ''}${biasLine(bias, signal)}

${block([
  prow('Entry', entry),
  prow('SL', sl),
  prow('TP1', tp1, rLabel(entry, sl, tp1)),
  prow('TP2', tp2, rLabel(entry, sl, tp2)),
  prow('TP3', tp3, rLabel(entry, sl, tp3)),
])}
${trend} · R:R 1:${rr}
_${getBerlinTime().slice(0,5)} · Apex_`;
}

function buildSignalMsg(signal, asset, entry, sl, tp1, tp2, tp3, rr, rsi, macd, bias, trend15m, liqTarget, swept, grade, score, factors, lot) {
  const emoji = signal === 'BUY' ? '🟢' : '🔴';

  // Setup-Zeile: nur die ERFÜLLTEN Faktoren nennen — viel lesbarer als eine Häkchen-Reihe
  let setupLine = '';
  if (factors) {
    const names = { sweep: 'Sweep', liquidity: 'Ziel', biasAlign: '4H', entryAlign: '15M', fvg: 'FVG', strongCandle: 'Kerze' };
    const hit = Object.keys(names).filter(k => factors[k]).map(k => names[k]);
    setupLine = `\nSetup ${score}/6 · ${hit.length ? hit.join(', ') : 'keine Bestätigung'}`;
  }
  const liqLine = liqTarget ? `\nZiel-Liquidität ${liqTarget.toFixed(2)}` : '';

  return `${emoji} *${signal} · ${asset}*
Scalp${grade ? ` · Grade ${grade}` : ''}${lot ? ` · ${lot} Lot` : ''}${biasLine(bias, signal)}${swept ? '\n🎯 Liquidity Sweep' : ''}

${block([
  prow('Entry', entry),
  prow('SL', sl),
  prow('TP1', tp1, rLabel(entry, sl, tp1)),
  prow('TP2', tp2, rLabel(entry, sl, tp2)),
  prow('TP3', tp3, rLabel(entry, sl, tp3)),
])}${setupLine}${liqLine}
RSI ${Math.round(parseFloat(rsi))} · MACD ${macd} · R:R 1:${rr}
_${getBerlinTime().slice(0,5)} · Apex_`;
}

function buildSwingSignalMsg(signal, asset, entry, sl, tp1, tp2, tp3, rr, rsi, trend, lot) {
  const emoji = signal === 'BUY' ? '🟢' : '🔴';
  return `${emoji} *${signal} · ${asset}*
Swing 1H${lot ? ` · ${lot} Lot` : ''} · ${trend}

${block([
  prow('Entry', entry),
  prow('SL', sl),
  prow('TP1', tp1, rLabel(entry, sl, tp1)),
  prow('TP2', tp2, rLabel(entry, sl, tp2)),
  prow('TP3', tp3, rLabel(entry, sl, tp3)),
])}
RSI ${Math.round(parseFloat(rsi))} · R:R 1:${rr} · Halten: Std–1 Tag
_${getBerlinTime().slice(0,5)} · Apex_`;
}

// ── Wochen-Auswertung (Freitag 22:00) — maximal detailliert ──
function statLine(label, arr) {
  if (!arr.length) return null;
  const w = arr.filter(t => t.result === 'WIN').length;
  const l = arr.filter(t => t.result === 'LOSS').length;
  const be = arr.filter(t => t.result === 'BE').length;
  const pnl = arr.reduce((a, t) => a + t.pnl, 0);
  const wr = (w + l) > 0 ? Math.round(w / (w + l) * 100) : 0;
  const beStr = be ? `/${be}BE` : '';
  return `${label.padEnd(9)} ${String(arr.length).padStart(3)}T  ${String(wr).padStart(3)}%  ${(pnl >= 0 ? '+' : '') + Math.round(pnl)}€  (${w}W/${l}L${beStr})`;
}

function buildWeeklyReport() {
  const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const wk = tradeHistory.filter(t => t.ts >= since);
  if (!wk.length) {
    return `📅 *WOCHEN-REPORT*\n_${getBerlinDate()}_\n\nKeine abgeschlossenen Trades in dieser Woche.\n_Apex_`;
  }
  const totalPnl = wk.reduce((a, t) => a + t.pnl, 0);
  const w = wk.filter(t => t.result === 'WIN').length;
  const l = wk.filter(t => t.result === 'LOSS').length;
  const wr = (w + l) > 0 ? Math.round(w / (w + l) * 100) : 0;

  const bySymbol = ['XAU/USD', 'NASDAQ 100'].map(sym => statLine(sym === 'XAU/USD' ? 'Gold' : 'NASDAQ', wk.filter(t => t.symbol === sym))).filter(Boolean);
  const byType = [['4confirm','Scalp'], ['swing','Swing'], ['opening_range','Range']].map(([k, lbl]) => statLine(lbl, wk.filter(t => t.type === k))).filter(Boolean);
  const byGrade = ['A+','A','B','C'].map(g => statLine('Grade '+g, wk.filter(t => t.grade === g))).filter(Boolean);
  const byReason = ['TP3','Trailing','BE','SL','Timeout'].map(r => statLine(r, wk.filter(t => t.reason === r))).filter(Boolean);
  const byDay = ['Mo','Di','Mi','Do','Fr'].map((lbl, i) => statLine(lbl, wk.filter(t => t.weekday === i + 1))).filter(Boolean);

  const best = wk.reduce((a, t) => t.pnl > a.pnl ? t : a, wk[0]);
  const worst = wk.reduce((a, t) => t.pnl < a.pnl ? t : a, wk[0]);

  const sec = (title, lines) => lines.length ? `\n*${title}*\n${block(lines)}` : '';

  return `📅 *WOCHEN-REPORT*
_${getBerlinDate()}_

${block([
  `Trades    ${wk.length}`,
  `Win-Rate  ${wr}%  (${w}W/${l}L)`,
  `PnL       ${(totalPnl >= 0 ? '+' : '') + Math.round(totalPnl)} €`,
])}${sec('Nach Symbol', bySymbol)}${sec('Nach Typ', byType)}${sec('Nach Grade', byGrade)}${sec('Nach Ausgang', byReason)}${sec('Nach Wochentag', byDay)}
🏆 Bester:  ${best.signal} ${best.symbol} +${Math.round(best.pnl)}€ (${best.reason})
💀 Schlimmster: ${worst.signal} ${worst.symbol} ${Math.round(worst.pnl)}€ (${worst.reason})
_Apex · Wochenschluss_`;
}

function buildPerformanceReport(asset, perf, sessionKey) {
  const total = perf.wins + perf.losses;
  const winRate = total > 0 ? ((perf.wins / total) * 100).toFixed(1) : '0';
  const totalMoney = perf.trades.reduce((a, t) => a + toPipsAndMoney(sessionKey, t.pnl, t.lot).money, 0);
  const totalFmt = `${totalMoney >= 0 ? '+' : ''}${totalMoney.toFixed(0)} €`;
  const se = perf.streakType === 'WIN' ? '🔥' : perf.streakType === 'LOSS' ? '🧊' : '·';
  const last = perf.trades.slice(-5).map(t => {
    const m = toPipsAndMoney(sessionKey, t.pnl, t.lot);
    return `${t.result === 'WIN' ? '✅' : '❌'} ${t.signal.padEnd(4)} ${(m.money >= 0 ? '+' : '') + m.money.toFixed(0)} €`;
  }).join('\n') || '–';

  return `📊 *Tages-Report · ${asset}*
_${getBerlinDate()}_

${block([
  prow('Wins', String(perf.wins)),
  prow('Losses', String(perf.losses)),
  prow('Win-Rate', winRate + '%'),
])}
💰 Total ${totalFmt}
${se} Serie ${perf.streak}× ${perf.streakType || '-'} · Best ${perf.bestStreak}× · Worst ${perf.worstStreak}×

Letzte Trades:
${last}
_Apex_`;
}

// ─── STORE & SYMBOL MAPPING ────────────────────────────────────────────────────
const store = {
  'XAUUSD': { closes: [], highs: [], lows: [], lastSignal: null },
  'NDX':    { closes: [], highs: [], lows: [], lastSignal: null },
};
// Separate Speicher für 1H Swing-Kerzen (werden aus dem 1M-Feed gebaut)
const swingStore = {
  'XAUUSD': { closes: [], highs: [], lows: [], lastSignal: null },
  'NDX':    { closes: [], highs: [], lows: [], lastSignal: null },
};

// ─── SWING 1H-BUILDER (aus dem 1M-Feed — kein separater Swing-Alarm nötig) ─────
// Zwischenspeicher für die gerade "im Bau" befindliche 1H-Kerze pro Symbol
const swingBuilder = {
  'XAUUSD': { hourKey: null, h: null, l: null, c: null },
  'NDX':    { hourKey: null, h: null, l: null, c: null },
};
function currentHourKey() {
  return new Date()
    .toLocaleString('sv-SE', {
      timeZone: 'Europe/Berlin',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    })
    .slice(0, 13); // "YYYY-MM-DD HH"
}
// Bei JEDER 1M-Kerze aufrufen. Gibt die abgeschlossene 1H-Kerze zurück (→ Strategie
// prüfen), sonst null solange die Stunde läuft. Legt fertige 1H-Kerzen in swingStore.
function feedSwingCandle(sessionKey, close, high, low) {
  const b = swingBuilder[sessionKey];
  if (!b) return null;
  const hk = currentHourKey();

  if (b.hourKey === null) {
    b.hourKey = hk; b.h = high; b.l = low; b.c = close;
    return null;
  }
  if (hk !== b.hourKey) {
    const finished = { close: b.c, high: b.h, low: b.l };
    const st = swingStore[sessionKey];
    st.closes.push(finished.close);
    st.highs.push(finished.high);
    st.lows.push(finished.low);
    while (st.closes.length > CONFIG.MAX_CANDLES) {
      st.closes.shift(); st.highs.shift(); st.lows.shift();
    }
    b.hourKey = hk; b.h = high; b.l = low; b.c = close;
    return finished;
  }
  b.h = Math.max(b.h, high);
  b.l = Math.min(b.l, low);
  b.c = close;
  return null;
}

function isSwing(symbol) {
  return symbol.toUpperCase().includes('SWING');
}
function getStore(symbol) {
  const s = symbol.toUpperCase();
  const swing = isSwing(symbol);
  const tbl = swing ? swingStore : store;
  if (s.includes('XAU') || s.includes('GOLD')) return tbl['XAUUSD'];
  if (s.includes('NAS') || s.includes('NDX') || s.includes('US100') || s.includes('NQ')) return tbl['NDX'];
  return null;
}
function getSessionKey(symbol) {
  const s = symbol.toUpperCase();
  if (s.includes('XAU') || s.includes('GOLD')) return 'XAUUSD';
  if (s.includes('NAS') || s.includes('NDX') || s.includes('US100') || s.includes('NQ')) return 'NDX';
  return null;
}
function getAssetLabel(symbol) {
  const s = symbol.toUpperCase();
  if (s.includes('XAU') || s.includes('GOLD')) return 'XAU/USD';
  if (s.includes('NAS') || s.includes('NDX') || s.includes('US100') || s.includes('NQ')) return 'NASDAQ 100';
  return symbol;
}
function normalizeSymbol(symbol) {
  const base = getSessionKey(symbol) || symbol.toUpperCase();
  return isSwing(symbol) ? `${base}_SWING` : base;
}

// ─── PERSISTENZ (Railway Volume) ───────────────────────────────────────────────
// Speichert Swing-Warmup + offene Trades, damit ein Redeploy sie nicht killt.
// In Railway ein Volume anlegen und auf /data mounten (oder DATA_DIR env setzen).
const DATA_DIR = process.env.DATA_DIR || '/data';
const STATE_FILE = path.join(DATA_DIR, 'apex-state.json');

// ─── TRADING-PAUSE (über das Dashboard steuerbar) ─────────────────────────────
// pauseUntil = ms-Zeitstempel, bis zu dem KEINE Orders platziert werden.
// Signale, Kerzen, Grades und die Statistik laufen trotzdem weiter (Daten sammeln!).
// null = aktiv. Ist die Zeit abgelaufen, schaltet sich der Bot selbst wieder scharf.
let pauseUntil = null;
function tradingPaused() {
  if (pauseUntil != null && Date.now() >= pauseUntil) {
    pauseUntil = null;
    console.log('▶️ Trading-Pause abgelaufen — Orders wieder aktiv');
    saveState();
  }
  return pauseUntil != null;
}

// ─── PROP-FIRM-MODUS (über das Dashboard konfigurierbar) ──────────────────────
// Reines Tracking gegen die Challenge-Regeln (Phase 1). Der harte Auto-Stop +
// echte Broker-Equity ist bewusst noch NICHT dran (Phase 2, braucht echtes Konto).
let propConfig = {
  enabled: false,
  firm: '',
  accountSize: 100000,   // Start-Balance der Challenge (Konto-Währung)
  profitTargetPct: 8,    // Gewinnziel in %
  dailyLossPct: 5,       // max. Tagesverlust in %
  maxDrawdownPct: 10,    // max. Gesamt-Drawdown in %
  minDays: 0,            // Mindest-Handelstage (0 = keine)
  startTs: null,         // Beginn der laufenden Challenge-Auswertung
};

// Rechnet den aktuellen Prop-Firm-Stand aus der persistenten Trade-Historie.
// Alle Beträge sind die GETRACKTEN (geschätzten) EUR-Werte — fürs Demo-Tracking ok,
// die echte Broker-Equity kommt in Phase 2 dazu.
function computeProp() {
  const c = propConfig;
  if (!c.enabled) return { enabled: false };
  const start = c.startTs || 0;
  const rows = tradeHistory.filter(t => t.ts >= start);
  const today = getBerlinDate();

  let total = 0, todayPnl = 0, peak = 0, cum = 0, maxDD = 0;
  const days = {};
  for (const t of rows) {
    const p = (typeof t.pnl === 'number') ? t.pnl : 0;
    total += p;
    cum += p;
    if (cum > peak) peak = cum;
    const dd = peak - cum;              // Rückgang vom Höchststand
    if (dd > maxDD) maxDD = dd;
    if (t.date === today) todayPnl += p;
    days[t.date] = true;
  }

  const targetEur  = c.accountSize * c.profitTargetPct / 100;
  const dailyEur   = c.accountSize * c.dailyLossPct    / 100;
  const maxDdEur   = c.accountSize * c.maxDrawdownPct  / 100;
  const tradingDays = Object.keys(days).length;

  // Ampel-Status je Regel
  const targetPct = targetEur > 0 ? Math.max(0, Math.min(100, total / targetEur * 100)) : 0;
  const dailyUsedPct = dailyEur > 0 ? Math.max(0, Math.min(100, -Math.min(0, todayPnl) / dailyEur * 100)) : 0;
  const ddUsedPct = maxDdEur > 0 ? Math.max(0, Math.min(100, maxDD / maxDdEur * 100)) : 0;

  const targetHit = total >= targetEur;
  const dailyBreached = (-todayPnl) >= dailyEur;
  const ddBreached = maxDD >= maxDdEur;
  const daysOk = tradingDays >= c.minDays;

  let status = 'laufend';
  if (dailyBreached || ddBreached) status = 'verletzt';
  else if (targetHit && daysOk) status = 'bestanden';
  else if (targetHit && !daysOk) status = 'ziel erreicht – noch Tage offen';

  return {
    enabled: true, firm: c.firm, accountSize: c.accountSize,
    profitTargetPct: c.profitTargetPct, dailyLossPct: c.dailyLossPct,
    maxDrawdownPct: c.maxDrawdownPct, minDays: c.minDays, startTs: c.startTs,
    total: +total.toFixed(2), todayPnl: +todayPnl.toFixed(2), maxDD: +maxDD.toFixed(2),
    targetEur: +targetEur.toFixed(0), dailyEur: +dailyEur.toFixed(0), maxDdEur: +maxDdEur.toFixed(0),
    targetPct: +targetPct.toFixed(1), dailyUsedPct: +dailyUsedPct.toFixed(1), ddUsedPct: +ddUsedPct.toFixed(1),
    tradingDays, targetHit, dailyBreached, ddBreached, daysOk, status,
    dailyRemain: +(dailyEur + Math.min(0, todayPnl)).toFixed(0),   // verbleibender Tagespuffer
    ddRemain: +(maxDdEur - maxDD).toFixed(0),                      // verbleibender DD-Puffer
  };
}

function saveState() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const state = { v: 1, savedAt: Date.now(), store, swingStore, swingBuilder, openTrades, lastTradeTime, tradeHistory, weeklyLastSent: weeklyReport.lastSent, pauseUntil, sessionData, dailyFlags, propConfig };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch (e) {
    console.warn('⚠️ State speichern fehlgeschlagen (Volume auf /data gemountet?):', e.message);
  }
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      console.log('ℹ️ Kein gespeicherter State — starte frisch (Swing sammelt neu).');
      return;
    }
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const k of ['XAUUSD', 'NDX']) {
      if (s.store && s.store[k]) {
        store[k].closes = s.store[k].closes || [];
        store[k].highs  = s.store[k].highs  || [];
        store[k].lows   = s.store[k].lows   || [];
      }
      if (s.swingStore && s.swingStore[k]) {
        swingStore[k].closes = s.swingStore[k].closes || [];
        swingStore[k].highs  = s.swingStore[k].highs  || [];
        swingStore[k].lows   = s.swingStore[k].lows   || [];
        swingStore[k].lastSignal = s.swingStore[k].lastSignal || null;
      }
      if (s.swingBuilder && s.swingBuilder[k]) Object.assign(swingBuilder[k], s.swingBuilder[k]);
    }
    if (Array.isArray(s.openTrades)) { openTrades.length = 0; openTrades.push(...s.openTrades); }
    if (s.lastTradeTime) Object.assign(lastTradeTime, s.lastTradeTime);
    if (Array.isArray(s.tradeHistory)) { tradeHistory.length = 0; tradeHistory.push(...s.tradeHistory); }
    if (s.weeklyLastSent) weeklyReport.lastSent = s.weeklyLastSent;
    if (typeof s.pauseUntil === 'number') pauseUntil = s.pauseUntil;
    if (s.propConfig) Object.assign(propConfig, s.propConfig);
    if (s.sessionData) for (const k of ['XAUUSD', 'NDX']) { if (s.sessionData[k]) Object.assign(sessionData[k], s.sessionData[k]); }
    if (s.dailyFlags) Object.assign(dailyFlags, s.dailyFlags);
    const age = s.savedAt ? Math.round((Date.now() - s.savedAt) / 1000) : '?';
    console.log(`✅ State geladen: ${store['XAUUSD'].closes.length}/${store['NDX'].closes.length} Scalp-Kerzen · ${swingStore['XAUUSD'].closes.length}/${swingStore['NDX'].closes.length} Swing-Kerzen · ${openTrades.length} offene Trades · ${tradeHistory.length} Trades in Historie (vor ${age}s gesichert)`);
  } catch (e) {
    console.warn('⚠️ State laden fehlgeschlagen:', e.message);
  }
}

// ─── SERVER ────────────────────────────────────────────────────────────────────
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="de"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Apex Signal Bot</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --void:#070710;--ink:#0C0B1B;--glass:rgba(150,134,255,.05);--glass2:rgba(150,134,255,.08);
  --line:rgba(150,134,255,.15);--line2:rgba(150,134,255,.28);
  --gold:#F4B33D;--cyan:#39E3FF;--violet:#9A6CFF;
  --profit:#22E6A0;--loss:#FF4E6A;
  --txt:#ECE9FF;--dim:#857FB0;
  --disp:'Space Grotesk',system-ui,sans-serif;--mono:'JetBrains Mono',ui-monospace,monospace;
}
html,body{height:100%}
body{background:var(--void);color:var(--txt);font-family:var(--disp);min-height:100vh;overflow-x:hidden;-webkit-font-smoothing:antialiased}
#bg{position:fixed;inset:0;width:100%;height:100%;z-index:0;opacity:.55;pointer-events:none}
.veil{position:fixed;inset:0;z-index:1;pointer-events:none;background:
  radial-gradient(120% 80% at 50% -10%,rgba(154,108,255,.16),transparent 60%),
  radial-gradient(90% 60% at 100% 110%,rgba(57,227,255,.10),transparent 55%),
  linear-gradient(180deg,transparent 40%,rgba(7,7,16,.75) 100%)}
.shell{position:relative;z-index:2;display:flex;min-height:100vh}

/* Nav rail */
.rail{width:72px;flex-shrink:0;display:flex;flex-direction:column;align-items:center;gap:6px;padding:18px 0;
  background:linear-gradient(180deg,rgba(12,11,27,.7),rgba(12,11,27,.35));backdrop-filter:blur(14px);border-right:1px solid var(--line)}
.mark{width:40px;height:40px;border-radius:12px;background:conic-gradient(from 210deg,var(--gold),var(--violet),var(--cyan),var(--gold));
  display:grid;place-items:center;font-size:20px;margin-bottom:14px;box-shadow:0 0 26px rgba(154,108,255,.5);animation:spinhue 14s linear infinite}
@keyframes spinhue{to{filter:hue-rotate(360deg)}}
.nav{width:46px;height:46px;border-radius:13px;display:grid;place-items:center;color:var(--dim);cursor:pointer;transition:.2s;border:1px solid transparent}
.nav svg{width:21px;height:21px;stroke:currentColor;fill:none;stroke-width:1.7}
.nav:hover{color:var(--txt);background:var(--glass)}
.nav.on{color:var(--txt);background:linear-gradient(135deg,rgba(154,108,255,.3),rgba(57,227,255,.12));border-color:var(--line2);box-shadow:0 0 18px rgba(154,108,255,.3)}
.pulse{margin-top:auto;width:9px;height:9px;border-radius:50%;background:var(--profit);box-shadow:0 0 12px var(--profit);animation:beat 1.8s ease-in-out infinite}
.pulse.off{background:var(--gold);box-shadow:0 0 12px var(--gold)}
@keyframes beat{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(.55);opacity:.5}}

/* Main */
.main{flex:1;min-width:0;padding:26px 30px 60px;max-width:1120px;margin:0 auto;width:100%}
.topline{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:4px}
.kicker{font-size:12px;color:var(--dim);font-weight:500;letter-spacing:.02em}
.ticktime{font-family:var(--mono);font-size:12px;color:var(--cyan);font-weight:700}
.title{font-size:30px;font-weight:700;letter-spacing:-.02em;margin-bottom:20px}

/* Hero command strip */
.hero{position:relative;border-radius:22px;padding:24px 26px;margin-bottom:18px;overflow:hidden;
  background:linear-gradient(135deg,rgba(20,17,44,.92),rgba(12,11,27,.72));border:1px solid var(--line2);
  box-shadow:0 24px 60px -24px rgba(0,0,0,.8),inset 0 1px 0 rgba(255,255,255,.05)}
.hero::before{content:"";position:absolute;inset:0;background:radial-gradient(70% 120% at 85% 0%,rgba(244,179,61,.14),transparent 60%);pointer-events:none}
.hero.paused::before{background:radial-gradient(70% 120% at 85% 0%,rgba(244,179,61,.22),transparent 60%)}
.statusline{display:flex;align-items:center;gap:10px;margin-bottom:14px}
.dot{width:10px;height:10px;border-radius:50%;background:var(--profit);box-shadow:0 0 14px var(--profit);animation:beat 1.8s ease-in-out infinite}
.dot.off{background:var(--gold);box-shadow:0 0 14px var(--gold)}
.statustxt{font-size:13px;font-weight:600;letter-spacing:.01em}
.statustxt.off{color:var(--gold)}
.statussub{font-size:12px;color:var(--dim);font-weight:400}
.pnl{font-family:var(--mono);font-weight:800;font-size:clamp(40px,11vw,66px);line-height:.95;letter-spacing:-.02em}
.pnl.up{color:var(--profit);text-shadow:0 0 34px rgba(34,230,160,.45)}
.pnl.down{color:var(--loss);text-shadow:0 0 34px rgba(255,78,106,.4)}
.pnllabel{font-size:12.5px;color:var(--dim);margin-top:6px}
.pnllabel b{color:var(--txt);font-weight:600}

/* Pause control */
.ctrl{margin-top:20px;padding-top:18px;border-top:1px solid var(--line);display:flex;gap:9px;flex-wrap:wrap;align-items:center}
.cbtn{font-family:var(--disp);font-weight:600;font-size:13px;padding:11px 15px;border-radius:12px;cursor:pointer;
  color:var(--txt);background:var(--glass2);border:1px solid var(--line2);transition:.16s;display:inline-flex;align-items:center;gap:7px}
.cbtn:hover{background:rgba(150,134,255,.16);transform:translateY(-1px)}
.cbtn:active{transform:translateY(0)}
.cbtn.pz{color:var(--gold);border-color:rgba(244,179,61,.4)}
.cbtn.go{color:var(--profit);border-color:rgba(34,230,160,.4)}
.cmin{width:78px;font-family:var(--mono);font-weight:700;font-size:13px;padding:11px 12px;border-radius:12px;
  background:rgba(7,7,16,.6);color:var(--txt);border:1px solid var(--line2);text-align:center}
.cmin::placeholder{color:var(--dim)}

/* Market tabs */
.tabs{display:flex;gap:8px;margin-bottom:16px}
.tab{flex:1;padding:12px 10px;border-radius:14px;cursor:pointer;font-weight:600;font-size:13px;text-align:center;
  background:var(--glass);border:1px solid var(--line);color:var(--dim);transition:.18s;display:flex;align-items:center;justify-content:center;gap:7px}
.tab:hover{color:var(--txt)}
.tab .tdot{width:7px;height:7px;border-radius:50%}
.tab.on{color:var(--txt);background:var(--glass2);border-color:var(--line2)}
.tab.on.g{box-shadow:inset 0 -2px 0 var(--gold),0 0 20px -6px var(--gold)}
.tab.on.c{box-shadow:inset 0 -2px 0 var(--cyan),0 0 20px -6px var(--cyan)}
.tab.on.v{box-shadow:inset 0 -2px 0 var(--violet),0 0 20px -6px var(--violet)}

/* Stat cards */
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:13px;margin-bottom:18px}
.stat{position:relative;border-radius:17px;padding:17px 18px;background:var(--glass);border:1px solid var(--line);overflow:hidden;
  opacity:0;transform:translateY(10px) scale(.99);animation:rise .5s cubic-bezier(.2,.8,.2,1) forwards}
.stat::after{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--violet);opacity:.75}
.stat.g::after{background:var(--gold)} .stat.c::after{background:var(--cyan)}
.stat.pos::after{background:var(--profit)} .stat.neg::after{background:var(--loss)}
.slabel{font-size:11px;color:var(--dim);font-weight:500;margin-bottom:9px}
.sval{font-family:var(--mono);font-weight:800;font-size:27px;line-height:1;letter-spacing:-.01em}
.sval.pos{color:var(--profit)} .sval.neg{color:var(--loss)} .sval.gold{color:var(--gold)} .sval.cyan{color:var(--cyan)}
.ssub{font-size:11px;color:var(--dim);margin-top:8px}
@keyframes rise{to{opacity:1;transform:none}}

/* Panels */
.panel{border-radius:19px;padding:19px 20px;background:var(--glass);border:1px solid var(--line);margin-bottom:16px}
.phead{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.ptitle{font-size:14px;font-weight:600}
.pmeta{font-family:var(--mono);font-size:11px;color:var(--dim)}
svg.eq{width:100%;height:150px;display:block}
.sect{font-size:12px;color:var(--dim);font-weight:600;margin:4px 0 11px}

/* Rows */
.rowitem{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:13px 15px;border-radius:13px;
  background:var(--glass);border:1px solid var(--line);margin-bottom:8px;border-left:3px solid var(--violet)}
.rowitem.buy{border-left-color:var(--profit)} .rowitem.sell{border-left-color:var(--loss)}
.rl{display:flex;align-items:center;gap:9px;font-weight:600;font-size:13.5px}
.rr{font-family:var(--mono);font-size:12px;color:var(--dim)}
.dir{font-weight:700} .dir.buy{color:var(--profit)} .dir.sell{color:var(--loss)}
.tag{font-size:10.5px;font-weight:800;padding:2px 8px;border-radius:7px}
.tag.gA{background:rgba(34,230,160,.16);color:var(--profit)}
.tag.gB{background:rgba(57,227,255,.16);color:var(--cyan)}
.tag.gC{background:rgba(255,78,106,.14);color:var(--loss)}
.chip{font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:7px;background:var(--glass2);color:var(--dim)}
.chip.g{color:var(--gold)} .chip.c{color:var(--cyan)}

/* Table */
.tbl{width:100%;border-collapse:collapse;border-radius:15px;overflow:hidden;border:1px solid var(--line)}
.tbl th{background:rgba(150,134,255,.07);color:var(--dim);font-size:11px;font-weight:600;padding:12px 14px;text-align:left}
.tbl td{padding:12px 14px;border-top:1px solid var(--line);font-size:13px;font-family:var(--mono)}
.tbl td.nm{font-family:var(--disp);font-weight:600}
.pos{color:var(--profit)} .neg{color:var(--loss)}

/* Strategy */
.srow{display:flex;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--line);font-size:13px}
.srow:last-child{border-bottom:none}
.srow .k{color:var(--dim)} .srow .v{font-weight:600;font-family:var(--mono)}
.scard{border-radius:16px;padding:16px 18px;background:var(--glass);border:1px solid var(--line);margin-bottom:13px}
.scard .ch{font-size:12px;color:var(--violet);font-weight:700;margin-bottom:4px}

.empty{text-align:center;padding:30px;color:var(--dim);font-size:13px}
.hide{display:none}
/* Prop firm */
.propform{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:14px}
.fld{display:flex;flex-direction:column;gap:6px}
.fld span{font-size:11px;color:var(--dim);font-weight:500}
.fld input{font-family:var(--mono);font-weight:700;font-size:14px;padding:11px 12px;border-radius:11px;background:rgba(7,7,16,.6);color:var(--txt);border:1px solid var(--line2)}
.fld input::placeholder{color:var(--dim)}
.propbtns{display:flex;gap:9px;flex-wrap:wrap;margin-bottom:12px}
.propnote{font-size:11.5px;color:var(--dim);line-height:1.5;padding:11px 13px;border-radius:11px;background:var(--glass);border:1px solid var(--line)}
.propbanner{border-radius:17px;padding:17px 19px;margin-bottom:16px;border:1px solid var(--line2);background:var(--glass)}
.propbanner .bfirm{font-size:13px;font-weight:700;letter-spacing:.01em}
.propbanner .bstat{font-size:12px;font-weight:700;padding:3px 10px;border-radius:8px;float:right}
.bs-run{background:rgba(57,227,255,.14);color:var(--cyan)} .bs-pass{background:rgba(34,230,160,.16);color:var(--profit)} .bs-fail{background:rgba(255,78,106,.16);color:var(--loss)} .bs-wait{background:rgba(244,179,61,.16);color:var(--gold)}
.pmeter{margin-top:14px}
.pmeter .plab{display:flex;justify-content:space-between;font-size:12px;margin-bottom:6px}
.pmeter .plab .pv{font-family:var(--mono);font-weight:700}
.pbar{height:9px;border-radius:6px;background:rgba(7,7,16,.6);overflow:hidden}
.pbar span{display:block;height:100%;border-radius:6px;transition:width .5s ease}
.pf-ok{background:linear-gradient(90deg,#22E6A0,#39E3FF)} .pf-warn{background:linear-gradient(90deg,#F4B33D,#FF4E6A)} .pf-bad{background:linear-gradient(90deg,#FF4E6A,#FF4E6A)}
.foot{text-align:center;margin-top:26px;font-size:11px;color:var(--dim);opacity:.6;font-family:var(--mono)}

@media(max-width:620px){
  .main{padding:18px 15px 80px}
  .title{font-size:24px}
  .rail{position:fixed;bottom:0;left:0;right:0;top:auto;width:100%;height:62px;flex-direction:row;justify-content:space-around;
    align-items:center;padding:0 8px;border-right:none;border-top:1px solid var(--line);z-index:30}
  .mark{display:none} .pulse{display:none}
  .nav{width:44px;height:44px}
  .shell{flex-direction:column}
}
@media(prefers-reduced-motion:reduce){*{animation:none!important}}
</style></head><body>
<canvas id="bg"></canvas>
<div class="veil"></div>
<div class="shell">
  <div class="rail">
    <div class="mark">⚡</div>
    <div class="nav on" id="n-dashboard" onclick="nav('dashboard')" title="Dashboard"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="11" width="7" height="10" rx="1.5"/><rect x="3" y="15" width="7" height="6" rx="1.5"/></svg></div>
    <div class="nav" id="n-positions" onclick="nav('positions')" title="Positionen"><svg viewBox="0 0 24 24"><path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 12l9 4 9-4"/><path d="M3 17l9 4 9-4"/></svg></div>
    <div class="nav" id="n-signals" onclick="nav('signals')" title="Signale"><svg viewBox="0 0 24 24"><path d="M5 12a7 7 0 0114 0"/><path d="M8 12a4 4 0 018 0"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/></svg></div>
    <div class="nav" id="n-history" onclick="nav('history')" title="Verlauf"><svg viewBox="0 0 24 24"><path d="M4 19V5"/><path d="M4 16l5-5 4 3 7-8"/></svg></div>
    <div class="nav" id="n-strategy" onclick="nav('strategy')" title="Strategie"><svg viewBox="0 0 24 24"><path d="M5 5v14M12 5v14M19 5v14"/><circle cx="5" cy="10" r="2.2" fill="var(--void)"/><circle cx="12" cy="15" r="2.2" fill="var(--void)"/><circle cx="19" cy="9" r="2.2" fill="var(--void)"/></svg></div>
    <div class="nav" id="n-prop" onclick="nav('prop')" title="Prop Firm"><svg viewBox="0 0 24 24"><path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg></div>
    <div class="pulse" id="railpulse"></div>
  </div>
  <div class="main">
    <div class="topline"><div class="kicker">Live-Cockpit · Gold &amp; NASDAQ</div><div class="ticktime" id="clock">--:--:--</div></div>
    <div class="title" id="vtitle">Dashboard</div>

    <!-- DASHBOARD -->
    <div id="v-dashboard">
      <div class="hero" id="hero">
        <div class="statusline"><span class="dot" id="hdot"></span><span class="statustxt" id="hstatus">Verbindung…</span><span class="statussub" id="hsub"></span></div>
        <div class="pnl up" id="pnl">+$0.00</div>
        <div class="pnllabel" id="pnllabel">Gesamt-Gewinn · <b>beide Märkte</b></div>
        <div class="ctrl">
          <button class="cbtn pz" onclick="ctrl('pause-midnight')">⏸ Bis Mitternacht</button>
          <input class="cmin" id="cmin" type="number" min="1" max="1440" placeholder="Min" inputmode="numeric">
          <button class="cbtn pz" onclick="ctrl('pause',document.getElementById('cmin').value)">⏸ Pausieren</button>
          <button class="cbtn go" onclick="ctrl('resume')">▶ Aktivieren</button>
        </div>
      </div>
      <div class="tabs">
        <div class="tab on v" id="t-combined" onclick="sw('combined')"><span class="tdot" style="background:var(--violet)"></span>Gesamt</div>
        <div class="tab g" id="t-gold" onclick="sw('gold')"><span class="tdot" style="background:var(--gold)"></span>XAU/USD</div>
        <div class="tab c" id="t-ndx" onclick="sw('ndx')"><span class="tdot" style="background:var(--cyan)"></span>NASDAQ</div>
      </div>
      <div class="grid" id="stats"></div>
      <div class="panel">
        <div class="phead"><div class="ptitle">Equity-Kurve</div><div class="pmeta" id="eqmeta"></div></div>
        <svg class="eq" id="eq" viewBox="0 0 600 150" preserveAspectRatio="none"></svg>
      </div>
      <div class="sect">Offene Positionen</div>
      <div id="opens"></div>
    </div>

    <!-- POSITIONS -->
    <div id="v-positions" class="hide"><div class="sect">Alle offenen Positionen</div><div id="posfull"></div></div>
    <!-- SIGNALS -->
    <div id="v-signals" class="hide"><div class="sect">Letzte Signale</div><div id="sigfull"></div></div>
    <!-- HISTORY -->
    <div id="v-history" class="hide">
      <div class="tabs">
        <div class="tab g" id="h-gold" onclick="sw('gold')"><span class="tdot" style="background:var(--gold)"></span>XAU/USD</div>
        <div class="tab c" id="h-ndx" onclick="sw('ndx')"><span class="tdot" style="background:var(--cyan)"></span>NASDAQ</div>
      </div>
      <div class="sect">Trade-Historie · echte EUR-Werte</div>
      <table class="tbl"><thead><tr><th>Zeit</th><th>Richtung</th><th>Ergebnis</th><th>Pips</th><th>Geld</th></tr></thead><tbody id="hist"></tbody></table>
    </div>
    <!-- STRATEGY -->
    <div id="v-strategy" class="hide"><div class="sect">Strategie &amp; Filter</div><div id="strat"></div></div>
    <!-- PROP FIRM -->
    <div id="v-prop" class="hide">
      <div id="propStatus"></div>
      <div class="sect">Challenge-Regeln</div>
      <div class="propform">
        <label class="fld"><span>Prop Firm</span><input id="p_firm" type="text" maxlength="40" placeholder="z.B. FTMO"></label>
        <label class="fld"><span>Account-Größe</span><input id="p_size" type="number" min="100" placeholder="100000"></label>
        <label class="fld"><span>Profit-Target %</span><input id="p_target" type="number" step="0.1" min="0.1" placeholder="8"></label>
        <label class="fld"><span>Daily-Loss %</span><input id="p_daily" type="number" step="0.1" min="0.1" placeholder="5"></label>
        <label class="fld"><span>Max-Drawdown %</span><input id="p_dd" type="number" step="0.1" min="0.1" placeholder="10"></label>
        <label class="fld"><span>Min. Handelstage</span><input id="p_days" type="number" min="0" placeholder="0"></label>
      </div>
      <div class="propbtns">
        <button class="cbtn go" onclick="saveProp()">💾 Regeln speichern</button>
        <button class="cbtn pz" onclick="propAct('reset')">↺ Challenge neu starten</button>
        <button class="cbtn" onclick="propAct('off')">Prop-Modus aus</button>
      </div>
      <div class="propnote">Phase 1: reines Tracking auf Basis der getrackten (geschätzten) P&amp;L. Der harte Auto-Stop und die echte Broker-Equity kommen in Phase 2 — erst mit echtem Prop-MT5.</div>
    </div>

    <div class="foot">Aktualisiert alle 5s · Apex Signal Bot</div>
  </div>
</div>
<script>
var cur='combined',page='dashboard',data=null,lastEq='';
var RM=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
var VIEWS=['dashboard','positions','signals','history','strategy','prop'];
var TITLES={dashboard:'Dashboard',positions:'Positionen',signals:'Signale',history:'Verlauf',strategy:'Strategie',prop:'Prop Firm'};

/* ---------- number formatting + count-up ---------- */
function fmt(v,dec,pre,suf,sign){
  var s=(sign&&v>0)?'+':'';
  return s+(pre||'')+Number(v).toLocaleString('de-DE',{minimumFractionDigits:dec||0,maximumFractionDigits:dec||0})+(suf||'');
}
function animNum(el,to,dec,pre,suf,sign){
  if(!el)return;
  var from=parseFloat(el.getAttribute('data-v'));if(isNaN(from))from=RM?to:0;
  el.setAttribute('data-v',to);
  if(RM||from===to){el.textContent=fmt(to,dec,pre,suf,sign);return;}
  var t0=performance.now();
  function step(now){var p=Math.min(1,(now-t0)/600);var e=1-Math.pow(1-p,3);var v=from+(to-from)*e;
    el.textContent=fmt(v,dec,pre,suf,sign);if(p<1)requestAnimationFrame(step);}
  requestAnimationFrame(step);
}

/* ---------- navigation ---------- */
function nav(p){
  page=p;
  for(var i=0;i<VIEWS.length;i++){
    document.getElementById('n-'+VIEWS[i]).className='nav'+(VIEWS[i]===p?' on':'');
    document.getElementById('v-'+VIEWS[i]).className=(VIEWS[i]===p?'':'hide');
  }
  document.getElementById('vtitle').textContent=TITLES[p];
  if((p==='history')&&cur==='combined'){cur='gold';}
  render();
}
function sw(t){cur=t;render();}
function setTabs(){
  var map={combined:'v',gold:'g',ndx:'c'};
  ['combined','gold','ndx'].forEach(function(x){var e=document.getElementById('t-'+x);if(e)e.className='tab '+map[x]+(x===cur?' on':'');});
  ['gold','ndx'].forEach(function(x){var e=document.getElementById('h-'+x);if(e)e.className='tab '+map[x]+(x===cur?' on':'');});
}

/* ---------- small builders ---------- */
function gtag(g){return g?'<span class="tag g'+(g[0]==='A'?'A':g==='B'?'B':'C')+'">'+g+'</span>':'';}
function stat(label,valHtml,sub,mod){return '<div class="stat '+(mod||'')+'"><div class="slabel">'+label+'</div><div class="sval '+(mod||'')+'">'+valHtml+'</div>'+(sub?'<div class="ssub">'+sub+'</div>':'')+'</div>';}

/* ---------- render ---------- */
function render(){
  if(!data)return;
  setTabs();
  // hero status
  var paused=data.paused;
  document.getElementById('hero').className='hero'+(paused?' paused':'');
  document.getElementById('hdot').className='dot'+(paused?' off':'');
  document.getElementById('railpulse').className='pulse'+(paused?' off':'');
  var st=document.getElementById('hstatus');
  if(paused){st.className='statustxt off';st.textContent='Trading pausiert';
    document.getElementById('hsub').textContent='wieder aktiv '+resumeTxt(data.pauseUntil)+' · Daten laufen weiter';}
  else{st.className='statustxt';st.textContent='Trading aktiv';document.getElementById('hsub').textContent='Orders werden automatisch platziert';}
  // hero number depends on tab
  var money,label;
  if(cur==='combined'){money=parseFloat(data.combined.money);label='Gesamt-Gewinn · <b>beide Märkte</b>';}
  else{money=parseFloat(data[cur].totalMoney);label=(cur==='gold'?'Gold · <b>XAU/USD</b>':'NASDAQ · <b>NAS100</b>');}
  var pnl=document.getElementById('pnl');pnl.className='pnl '+(money>=0?'up':'down');
  animNum(pnl,money,2,(money>=0?'+$':'$'),'',false);
  document.getElementById('pnllabel').innerHTML=label;

  if(page==='dashboard')renderStats();
  if(page==='positions')renderPositions();
  if(page==='signals')renderSignals();
  if(page==='history')renderHistory();
  if(page==='strategy')renderStrategy();
  if(page==='prop')renderProp();
  if(page==='dashboard')renderOpens();
}
function renderStats(){
  var el=document.getElementById('stats');var h='';
  if(cur==='combined'){
    var c=data.combined;
    h+=stat('Win-Rate','<span id="s_wr"></span>',c.wins+'W / '+c.losses+'L',parseFloat(c.winRate)>=50?'pos':'neg');
    h+=stat('Total Pips','<span id="s_pips"></span>','beide Märkte',parseFloat(c.pips)>=0?'pos':'neg');
    h+=stat('Gold','<span id="s_gold"></span>',data.gold.winRate+'% WR','g');
    h+=stat('NASDAQ','<span id="s_ndx"></span>',data.ndx.winRate+'% WR','c');
    el.innerHTML=h;
    animNum(document.getElementById('s_wr'),parseFloat(c.winRate),1,'','%');
    animNum(document.getElementById('s_pips'),parseFloat(c.pips),1,'','',true);
    animNum(document.getElementById('s_gold'),parseFloat(data.gold.totalMoney),0,'$','',true);
    animNum(document.getElementById('s_ndx'),parseFloat(data.ndx.totalMoney),0,'$','',true);
  } else {
    var d=data[cur],mk=cur==='gold'?'gold':'cyan';
    h+=stat('Win-Rate','<span id="s_wr"></span>',d.wins+'W / '+d.losses+'L',parseFloat(d.winRate)>=50?'pos':'neg');
    h+=stat('Total Pips','<span id="s_pips"></span>','',parseFloat(d.totalPips)>=0?'pos':'neg');
    h+=stat('Serie','<span id="s_streak"></span>','beste: '+d.bestStreak+'×',d.streakType==='WIN'?'pos':d.streakType==='LOSS'?'neg':'');
    h+=stat('Kerzen','<span id="s_cand"></span>','Swing '+d.swingCandles+(d.swingCandles>=d.swingNeeded?' ✅':' / '+d.swingNeeded),mk);
    h+=stat('Bias',(d.bias||'-'),'Tagesrichtung','gold');
    el.innerHTML=h;
    animNum(document.getElementById('s_wr'),parseFloat(d.winRate),1,'','%');
    animNum(document.getElementById('s_pips'),parseFloat(d.totalPips),1,'','',true);
    document.getElementById('s_streak').textContent=d.streak+'× '+(d.streakType||'-');
    animNum(document.getElementById('s_cand'),parseFloat(d.candles),0);
  }
  drawEq(cur==='combined'?mergeEq(data.gold.equity,data.ndx.equity):data[cur].equity);
  document.getElementById('eqmeta').textContent=cur==='combined'?'Gesamt':(cur==='gold'?'XAU/USD':'NASDAQ');
}
function renderOpens(){
  var ot=(data.openTrades||[]).filter(function(t){return cur==='combined'?true:(cur==='gold'?t.symbol.indexOf('XAU')>=0:t.symbol.indexOf('NASDAQ')>=0);});
  document.getElementById('opens').innerHTML=ot.length?ot.map(function(t){
    return '<div class="rowitem '+(t.signal==='BUY'?'buy':'sell')+'"><span class="rl"><span class="dir '+(t.signal==='BUY'?'buy':'sell')+'">'+t.signal+'</span> '+t.type+gtag(t.grade)+'</span><span class="rr">Entry '+t.entry+(t.tp1Hit?' · TP1✅':'')+(t.tp2Hit?' TP2🛡':'')+'</span></div>';
  }).join(''):'<div class="empty">Keine offenen Positionen</div>';
}
function renderPositions(){
  var ot=data.openTrades||[];
  document.getElementById('posfull').innerHTML=ot.length?ot.map(function(t){
    return '<div class="rowitem '+(t.signal==='BUY'?'buy':'sell')+'"><span class="rl"><span class="dir '+(t.signal==='BUY'?'buy':'sell')+'">'+t.signal+'</span> '+t.symbol+' · '+t.type+gtag(t.grade)+'</span><span class="rr">Entry '+t.entry+(t.tp1Hit?' · TP1✅':'')+(t.tp2Hit?' TP2🛡':'')+'</span></div>';
  }).join(''):'<div class="empty">Keine offenen Positionen</div>';
}
function renderSignals(){
  var s=data.signals||[];
  document.getElementById('sigfull').innerHTML=s.length?s.map(function(x){
    return '<div class="rowitem '+(x.signal==='BUY'?'buy':'sell')+'"><span class="rl"><span class="dir '+(x.signal==='BUY'?'buy':'sell')+'">'+x.signal+'</span> '+x.symbol+gtag(x.grade)+'</span><span class="rr">'+x.type+' · '+x.entry+' · '+x.time+'</span></div>';
  }).join(''):'<div class="empty">Noch keine Signale gesendet</div>';
}
function renderHistory(){
  var d=data[cur];var tr=(d&&d.trades)?d.trades:[];
  document.getElementById('hist').innerHTML=tr.length?tr.map(function(t){
    return '<tr><td class="nm">'+t.time+'</td><td class="'+(t.signal==='BUY'?'pos':'neg')+'">'+t.signal+'</td><td>'+(t.result==='WIN'?'✅ WIN':'❌ LOSS')+'</td><td class="'+(t.pips>=0?'pos':'neg')+'">'+(t.pips>0?'+':'')+t.pips+'</td><td class="'+(t.money>=0?'pos':'neg')+'">'+(t.money>0?'+':'')+'$'+t.money+'</td></tr>';
  }).join(''):'<tr><td colspan="5" class="empty">Noch keine Trades</td></tr>';
}
function renderStrategy(){
  var s=data.strategy;if(!s){document.getElementById('strat').innerHTML='<div class="empty">–</div>';return;}
  function r(k,v){return '<div class="srow"><span class="k">'+k+'</span><span class="v">'+v+'</span></div>';}
  function yn(b){return b?'✅':'—';}
  document.getElementById('strat').innerHTML=
    '<div class="scard"><div class="ch">Risiko &amp; Ziele</div>'+r('Stop Loss','1.3 × ATR')+r('TP1 / TP2 / TP3',s.tp1+' / '+s.tp2+' / '+s.tp3+' × ATR')+r('Cooldown',s.cooldown+' Min')+'</div>'+
    '<div class="scard"><div class="ch">Schärfere Fenster</div>'+r('Asia',s.asia)+r('Abend',s.evening)+'</div>'+
    '<div class="scard"><div class="ch">Gold-Filter</div>'+r('Min. ATR',s.gold.minAtrPercent+'%')+r('4H-Bias',yn(s.gold.require4hAlign))+r('5M-Entry',yn(s.gold.require5mAlign))+r('Liquidität',yn(s.gold.requireLiquidity))+r('Sweep-Boost',yn(s.gold.sweepBoost))+'</div>'+
    '<div class="scard"><div class="ch">NASDAQ-Filter</div>'+r('Min. ATR',s.ndx.minAtrPercent+'%')+r('Cooldown',s.ndx.cooldownMin+' Min')+r('15M-Align',yn(s.ndx.require15mAlign))+r('4H-Bias',yn(s.ndx.require4hAlign))+r('Liquidität',yn(s.ndx.requireLiquidity))+'</div>';
}

/* ---------- equity curve ---------- */
function mergeEq(a,b){a=a||[];b=b||[];var n=Math.max(a.length,b.length),o=[],la=a.length?a[a.length-1]:0,lb=b.length?b[b.length-1]:0;
  for(var i=0;i<n;i++){o.push((a[i]==null?la:a[i])+(b[i]==null?lb:b[i]));}return o;}
function drawEq(eq){
  var svg=document.getElementById('eq');
  if(!eq||eq.length<2){svg.innerHTML='<text x="300" y="75" fill="#857FB0" font-size="12" text-anchor="middle" font-family="JetBrains Mono">Noch nicht genug Daten</text>';return;}
  var min=Math.min(0,Math.min.apply(null,eq)),max=Math.max(0,Math.max.apply(null,eq)),rng=(max-min)||1;
  var W=600,H=150,pad=10,last=eq[eq.length-1],up=last>=0;
  var pts=eq.map(function(v,i){var x=pad+(i/(eq.length-1))*(W-2*pad);var y=H-pad-((v-min)/rng)*(H-2*pad);return [x,y];});
  var line=pts.map(function(p,i){return (i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1);}).join(' ');
  var area=line+' L'+pts[pts.length-1][0].toFixed(1)+' '+(H-pad)+' L'+pad+' '+(H-pad)+' Z';
  var zeroY=(H-pad-((0-min)/rng)*(H-2*pad)).toFixed(1);
  var c1=up?'#22E6A0':'#FF4E6A';
  var key=eq.length+':'+last.toFixed(1)+':'+up;
  var dash=(line.length>0)?2400:0;
  svg.innerHTML=
    '<defs>'+
    '<linearGradient id="egf" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="'+c1+'" stop-opacity="0.32"/><stop offset="100%" stop-color="'+c1+'" stop-opacity="0"/></linearGradient>'+
    '<linearGradient id="egl" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#F4B33D"/><stop offset="55%" stop-color="'+ (up?'#22E6A0':'#FF4E6A') +'"/><stop offset="100%" stop-color="#39E3FF"/></linearGradient>'+
    '<filter id="egg"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>'+
    '</defs>'+
    '<line x1="'+pad+'" y1="'+zeroY+'" x2="'+(W-pad)+'" y2="'+zeroY+'" stroke="#9A6CFF" stroke-opacity="0.25" stroke-width="1" stroke-dasharray="4 5"/>'+
    '<path d="'+area+'" fill="url(#egf)"/>'+
    '<path d="'+line+'" fill="none" stroke="url(#egl)" stroke-width="2.4" filter="url(#egg)" stroke-linecap="round" stroke-linejoin="round"'+(key!==lastEq&&!RM?(' stroke-dasharray="'+dash+'" stroke-dashoffset="'+dash+'" style="animation:draw .9s ease forwards"'):'')+'/>';
  if(key!==lastEq&&!RM){
    if(!document.getElementById('eqkf')){var s=document.createElement('style');s.id='eqkf';s.textContent='@keyframes draw{to{stroke-dashoffset:0}}';document.head.appendChild(s);}
  }
  lastEq=key;
}

/* ---------- prop firm ---------- */
var propFormInit=false;
function eur(v){return (v>=0?'+':'')+'$'+Number(v).toLocaleString('de-DE',{maximumFractionDigits:0});}
function meter(label,valueTxt,pct,mode){
  var cls=mode==='bad'?'pf-bad':mode==='warn'?'pf-warn':'pf-ok';
  return '<div class="pmeter"><div class="plab"><span>'+label+'</span><span class="pv">'+valueTxt+'</span></div><div class="pbar"><span class="'+cls+'" style="width:'+Math.max(2,Math.min(100,pct))+'%"></span></div></div>';
}
function renderProp(){
  var p=data?data.prop:null;
  // Formular einmalig mit gespeicherten Werten füllen
  if(p&&p.enabled&&!propFormInit){
    document.getElementById('p_firm').value=p.firm||'';
    document.getElementById('p_size').value=p.accountSize;
    document.getElementById('p_target').value=p.profitTargetPct;
    document.getElementById('p_daily').value=p.dailyLossPct;
    document.getElementById('p_dd').value=p.maxDrawdownPct;
    document.getElementById('p_days').value=p.minDays;
    propFormInit=true;
  }
  var box=document.getElementById('propStatus');
  if(!p||!p.enabled){
    box.innerHTML='<div class="propbanner"><div class="bfirm">Noch keine Challenge aktiv</div><div style="font-size:12px;color:var(--dim);margin-top:6px">Trag unten deine Firma und die Regeln ein und speichere — dann trackt der Bot live mit.</div></div>';
    return;
  }
  // Status-Chip
  var chip,chipTxt;
  if(p.dailyBreached||p.ddBreached){chip='bs-fail';chipTxt='Regel verletzt';}
  else if(p.targetHit&&p.daysOk){chip='bs-pass';chipTxt='Bestanden 🏆';}
  else if(p.targetHit){chip='bs-wait';chipTxt='Ziel erreicht — Tage offen';}
  else{chip='bs-run';chipTxt='Läuft';}
  // Target-Meter (mehr = besser)
  var tgtMode=p.targetHit?'ok':'ok';
  var tgt=meter('Profit-Target · Ziel '+eur(p.targetEur),eur(p.total)+' · '+p.targetPct.toFixed(0)+'%',p.targetPct,tgtMode);
  // Daily-Loss-Meter (mehr verbraucht = schlechter)
  var dMode=p.dailyBreached?'bad':p.dailyUsedPct>=70?'warn':'ok';
  var dly=meter('Daily-Loss · Limit '+eur(-p.dailyEur),'Puffer '+eur(p.dailyRemain)+' · '+p.dailyUsedPct.toFixed(0)+'% weg',p.dailyUsedPct,dMode);
  // Drawdown-Meter
  var ddMode=p.ddBreached?'bad':p.ddUsedPct>=70?'warn':'ok';
  var ddm=meter('Max-Drawdown · Limit '+eur(-p.maxDdEur),'Puffer '+eur(p.ddRemain)+' · '+p.ddUsedPct.toFixed(0)+'% weg',p.ddUsedPct,ddMode);
  // Tage
  var daysm='<div class="pmeter"><div class="plab"><span>Handelstage · min. '+p.minDays+'</span><span class="pv">'+p.tradingDays+(p.daysOk?' ✅':'')+'</span></div></div>';
  box.innerHTML='<div class="propbanner"><span class="bstat '+chip+'">'+chipTxt+'</span><div class="bfirm">'+(p.firm||'Prop Firm')+' · '+eur(p.accountSize).replace('+','')+'</div>'+tgt+dly+ddm+daysm+'</div>';
}
function saveProp(){
  var q='/prop?action=save'
    +'&firm='+encodeURIComponent(document.getElementById('p_firm').value||'')
    +'&accountSize='+encodeURIComponent(document.getElementById('p_size').value||'100000')
    +'&profitTargetPct='+encodeURIComponent(document.getElementById('p_target').value||'8')
    +'&dailyLossPct='+encodeURIComponent(document.getElementById('p_daily').value||'5')
    +'&maxDrawdownPct='+encodeURIComponent(document.getElementById('p_dd').value||'10')
    +'&minDays='+encodeURIComponent(document.getElementById('p_days').value||'0');
  fetch(q).then(function(){propFormInit=false;return refresh();}).catch(function(e){alert('Fehler: '+e.message);});
}
function propAct(action){
  if(action==='reset'&&!confirm('Challenge-Zähler wirklich auf 0 setzen?'))return;
  if(action==='off'&&!confirm('Prop-Modus ausschalten?'))return;
  fetch('/prop?action='+action).then(function(){propFormInit=false;return refresh();}).catch(function(e){alert('Fehler: '+e.message);});
}

/* ---------- control ---------- */
function resumeTxt(ts){if(!ts)return '';try{return new Date(ts).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})+' Uhr';}catch(e){return '';}}
function ctrl(action,min){
  var url='/control?action='+action;
  if(action==='pause'){var m=parseInt(min||'0',10);if(!m||m<1){alert('Bitte eine Minutenzahl eingeben');return;}url+='&min='+m;}
  fetch(url).then(function(){return refresh();}).catch(function(e){alert('Fehler: '+e.message);});
}

/* ---------- data ---------- */
function refresh(){
  return fetch('/data').then(function(r){return r.json();}).then(function(j){
    data=j;
    document.getElementById('clock').textContent=j.time;
    render();
  }).catch(function(){document.getElementById('hstatus').textContent='Offline';document.getElementById('hdot').className='dot off';});
}
refresh();setInterval(refresh,5000);

/* ---------- 3D market field background ---------- */
(function(){
  var cv=document.getElementById('bg');if(!cv)return;var ctx=cv.getContext('2d');if(!ctx)return;
  var GX=26,GY=15,dpr=Math.min(2,window.devicePixelRatio||1),w=0,h=0,run=true;
  function size(){w=cv.clientWidth;h=cv.clientHeight;cv.width=w*dpr;cv.height=h*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);}
  window.addEventListener('resize',size);size();
  document.addEventListener('visibilitychange',function(){run=!document.hidden;if(run&&!RM)requestAnimationFrame(loop);});
  function project(x,y,z){ // simple perspective
    var cam=3.0;var s=cam/(cam+z);return {x:w/2+x*s*w*0.62,y:h*0.46+y*s*h*0.9,s:s};
  }
  function frame(t){
    ctx.clearRect(0,0,w,h);
    var rot=t*0.00008, tilt=0.95;
    var cosR=Math.cos(rot),sinR=Math.sin(rot),cosT=Math.cos(tilt),sinT=Math.sin(tilt);
    var pts=[];
    for(var iy=0;iy<GY;iy++){
      pts[iy]=[];
      for(var ix=0;ix<GX;ix++){
        var gx=(ix/(GX-1)-0.5)*2.4;
        var gz=(iy/(GY-1)-0.5)*2.4;
        var wave=Math.sin(gx*2.1+t*0.0011)*0.16+Math.cos(gz*2.3+t*0.0009)*0.16;
        // rotate around Y
        var rx=gx*cosR+gz*sinR, rz=-gx*sinR+gz*cosR;
        // tilt around X
        var ry=wave*cosT - rz*sinT, rrz=wave*sinT + rz*cosT + 1.1;
        pts[iy][ix]=project(rx,ry,rrz);
      }
    }
    for(iy=0;iy<GY;iy++){for(ix=0;ix<GX;ix++){
      var p=pts[iy][ix];
      var hue=ix/(GX-1);
      var col=hue<0.5?lerpC([244,179,61],[154,108,255],hue*2):lerpC([154,108,255],[57,227,255],(hue-0.5)*2);
      if(ix<GX-1){var q=pts[iy][ix+1];seg(p,q,col,0.16*p.s);}
      if(iy<GY-1){var r=pts[iy+1][ix];seg(p,r,col,0.16*p.s);}
      ctx.beginPath();ctx.arc(p.x,p.y,1.1*p.s+0.3,0,6.283);ctx.fillStyle='rgba('+col[0]+','+col[1]+','+col[2]+','+(0.5*p.s)+')';ctx.fill();
    }}
  }
  function seg(a,b,c,al){ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.strokeStyle='rgba('+c[0]+','+c[1]+','+c[2]+','+al+')';ctx.lineWidth=1;ctx.stroke();}
  function lerpC(a,b,t){return [Math.round(a[0]+(b[0]-a[0])*t),Math.round(a[1]+(b[1]-a[1])*t),Math.round(a[2]+(b[2]-a[2])*t)];}
  var last=0;
  function loop(t){if(!run)return;if(t-last>33){frame(t);last=t;}requestAnimationFrame(loop);}
  if(RM){frame(1200);}else{requestAnimationFrame(loop);}
})();
</script></body></html>`;

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); return res.end(); }

  // Health check
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    const sd = sessionData['XAUUSD'];
    const swingNeeded = CONFIG.SWING_EMA_SLOW + 5;
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end([
      '⚡ Apex Signal Bot v4 läuft ✅',
      `🕐 Berlin: ${getBerlinTime()} (${getBerlinDate()})`,
      '',
      `XAU/USD Kerzen: ${store['XAUUSD'].closes.length}`,
      `NDX Kerzen:     ${store['NDX'].closes.length}`,
      `Offene Trades:  ${openTrades.length}`,
      '',
      '── XAU/USD Session ──',
      `Asia: H ${sd.asiaHigh ?? '-'} / L ${sd.asiaLow ?? '-'}`,
      `London brach: High ${sd.londonBrokeHigh} | Low ${sd.londonBrokeLow}`,
      `Bias: ${sd.lastBias || '-'} (gesendet: ${sd.biasSent})`,
      `Opening Range: H ${sd.openingRange.high ?? '-'} / L ${sd.openingRange.low ?? '-'}`,
      `Performance heute: ${sd.performance.wins}W / ${sd.performance.losses}L`,
      '',
      `── Swing (1H aus 1M-Feed) — braucht ${swingNeeded} Kerzen für EMA${CONFIG.SWING_EMA_SLOW} ──`,
      `XAU/USD Swing-Kerzen: ${swingStore['XAUUSD'].closes.length} ${swingStore['XAUUSD'].closes.length >= swingNeeded ? '✅' : '(sammelt...)'}`,
      `NDX Swing-Kerzen:     ${swingStore['NDX'].closes.length} ${swingStore['NDX'].closes.length >= swingNeeded ? '✅' : '(sammelt...)'}`,
      `💾 Persistenz: ${fs.existsSync(STATE_FILE) ? 'aktiv (' + STATE_FILE + ')' : 'INAKTIV — Volume auf /data mounten!'}`,
      `🤖 Broker: ${(() => { const s = broker.status(); return `${s.ready ? 'verbunden' : 'nicht verbunden'} · ${s.execute ? 'EXECUTE AN' : 'Dry-Run'} · offen ${s.openCount}/${s.maxOpen}`; })()}`,
      '',
      `Scalp: ${CONFIG.REQUIRE_EMA_CROSS ? 'EMA-Cross (streng)' : 'EMA-Zustand (gelockert)'} · Cooldown ${CONFIG.COOLDOWN_MIN || 'aus'} · Bias-Filter ${CONFIG.REQUIRE_BIAS_ALIGN ? 'an' : 'aus'} · Lot: Scalp fix / Swing risikobasiert`,
      `Token gesetzt: ${TOKEN ? 'ja' : 'NEIN ⚠️'}`,
      '',
      '👉 Schickes Dashboard: /dashboard',
    ].join('\n'));
  }

  // Dashboard JSON-Daten
  if (req.method === 'GET' && req.url === '/data') {
    const swingNeeded = CONFIG.SWING_EMA_SLOW + 5;
    const build = (key) => {
      const sd = sessionData[key];
      const perf = sd.performance;
      const total = perf.wins + perf.losses;
      const pips = perf.trades.reduce((a, t) => a + toPipsAndMoney(key, t.pnl, t.lot).pips, 0);
      const money = perf.trades.reduce((a, t) => a + toPipsAndMoney(key, t.pnl, t.lot).money, 0);
      let cum = 0;
      const equity = perf.trades.map(t => {
        cum += toPipsAndMoney(key, t.pnl, t.lot).money;
        return parseFloat(cum.toFixed(2));
      });
      return {
        candles: store[key].closes.length,
        swingCandles: swingStore[key].closes.length,
        swingNeeded,
        wins: perf.wins, losses: perf.losses,
        winRate: total > 0 ? (perf.wins / total * 100).toFixed(1) : '0',
        streak: perf.streak, streakType: perf.streakType,
        bestStreak: perf.bestStreak, worstStreak: perf.worstStreak,
        totalPips: pips.toFixed(1), totalMoney: money.toFixed(2),
        bias: sd.lastBias || '-',
        asiaHigh: sd.asiaHigh, asiaLow: sd.asiaLow,
        equity,
        trades: perf.trades.slice(-15).reverse().map(t => {
          const pm = toPipsAndMoney(key, t.pnl, t.lot);
          return { signal: t.signal, result: t.result, pips: pm.pips.toFixed(1), money: pm.money.toFixed(2), time: t.time };
        }),
      };
    };
    const gold = build('XAUUSD'), ndx = build('NDX');
    const allWins = gold.wins + ndx.wins;
    const allLosses = gold.losses + ndx.losses;
    const allTotal = allWins + allLosses;
    const combinedMoney = (parseFloat(gold.totalMoney) + parseFloat(ndx.totalMoney)).toFixed(2);
    const combinedPips = (parseFloat(gold.totalPips) + parseFloat(ndx.totalPips)).toFixed(1);
    const payload = {
      time: getBerlinTime(), date: getBerlinDate(),
      paused: tradingPaused(), pauseUntil,
      prop: computeProp(),
      openTrades: openTrades.map(t => ({ symbol: getAssetLabel(t.symbol), signal: t.signal, type: t.type, entry: t.entry, grade: t.grade || null, tp1Hit: !!t.tp1Hit, tp2Hit: !!t.tp2Hit })),
      signals: signalLog.slice(0, 20),
      strategy: {
        sl: CONFIG.SL_MULT, tp1: CONFIG.TP1_MULT, tp2: CONFIG.TP2_MULT, tp3: CONFIG.TP3_MULT,
        cooldown: CONFIG.COOLDOWN_MIN, minAtr: CONFIG.MIN_ATR_PERCENT,
        asia: `${CONFIG.ASIA_START_MIN/60}:00–${CONFIG.ASIA_END_MIN/60}:00`,
        evening: `${CONFIG.EVENING_START_MIN/60}:00–${CONFIG.EVENING_END_MIN/60}:00`,
        ndx: SYMBOL_FILTERS['NDX'], gold: SYMBOL_FILTERS['XAUUSD'],
      },
      combined: {
        wins: allWins, losses: allLosses,
        winRate: allTotal > 0 ? (allWins / allTotal * 100).toFixed(1) : '0',
        money: combinedMoney, pips: combinedPips,
      },
      gold, ndx,
    };
    const body = JSON.stringify(payload);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(body);
  }

  // Trading-Steuerung (Pause/Resume) — wird vom Dashboard aufgerufen
  if (req.method === 'GET' && req.url.startsWith('/control')) {
    const u = new URL(req.url, 'http://localhost');
    const action = u.searchParams.get('action');
    let msg = '';
    if (action === 'pause-midnight') {
      const minsLeft = (24 * 60) - berlinMinutesOfDay();
      pauseUntil = Date.now() + Math.max(1, minsLeft) * 60 * 1000;
      msg = 'Pausiert bis Mitternacht (Berlin)';
    } else if (action === 'pause') {
      const min = Math.max(1, Math.min(1440, parseInt(u.searchParams.get('min') || '0', 10)));
      pauseUntil = Date.now() + min * 60 * 1000;
      msg = `Pausiert für ${min} Min`;
    } else if (action === 'resume') {
      pauseUntil = null;
      msg = 'Wieder aktiv — Orders werden platziert';
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: 'Unbekannte action' }));
    }
    saveState();
    console.log(`⏯ Trading-Steuerung: ${msg}`);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, msg, paused: pauseUntil != null, pauseUntil }));
  }

  // Prop-Firm-Konfiguration (speichern / Challenge starten / aus)
  if (req.method === 'GET' && req.url.startsWith('/prop')) {
    const u = new URL(req.url, 'http://localhost');
    const action = u.searchParams.get('action');
    const num = (k, def, min, max) => {
      const v = parseFloat(u.searchParams.get(k));
      if (isNaN(v)) return def;
      return Math.max(min, Math.min(max, v));
    };
    let msg = '';
    if (action === 'save') {
      propConfig.firm = (u.searchParams.get('firm') || '').slice(0, 40);
      propConfig.accountSize    = num('accountSize', propConfig.accountSize, 100, 100000000);
      propConfig.profitTargetPct = num('profitTargetPct', propConfig.profitTargetPct, 0.1, 100);
      propConfig.dailyLossPct    = num('dailyLossPct', propConfig.dailyLossPct, 0.1, 100);
      propConfig.maxDrawdownPct  = num('maxDrawdownPct', propConfig.maxDrawdownPct, 0.1, 100);
      propConfig.minDays         = Math.round(num('minDays', propConfig.minDays, 0, 365));
      propConfig.enabled = true;
      if (!propConfig.startTs) propConfig.startTs = Date.now();   // Challenge beginnt beim ersten Speichern
      msg = 'Regeln gespeichert';
    } else if (action === 'reset') {
      propConfig.startTs = Date.now();   // Auswertung ab jetzt neu
      msg = 'Challenge neu gestartet (Zähler auf 0)';
    } else if (action === 'off') {
      propConfig.enabled = false;
      msg = 'Prop-Modus aus';
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: 'Unbekannte action' }));
    }
    saveState();
    console.log(`🏦 Prop-Firm: ${msg} (${propConfig.firm || '—'})`);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, msg, prop: computeProp() }));
  }

  // Dashboard HTML
  if (req.method === 'GET' && req.url === '/dashboard') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(DASHBOARD_HTML);
  }

  // Webhook
  if (req.method === 'POST' && req.url === '/webhook') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const symbol = (data.symbol || data.ticker || '').toString();
        const close = parseFloat(data.close);
        const high = parseFloat(data.high ?? data.close);
        const low = parseFloat(data.low ?? data.close);

        if (!symbol || isNaN(close) || isNaN(high) || isNaN(low)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'Ungültige Felder (symbol/close/high/low)' }));
        }

        const st = getStore(symbol);
        if (!st) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'Unbekanntes Symbol: ' + symbol }));
        }

        const normSym = normalizeSymbol(symbol);
        const assetLabel = getAssetLabel(symbol);
        const sessionKey = getSessionKey(symbol);
        const sd = sessionKey ? sessionData[sessionKey] : null;

        // Kerzen speichern
        st.closes.push(close); st.highs.push(high); st.lows.push(low);
        if (st.closes.length > CONFIG.MAX_CANDLES) { st.closes.shift(); st.highs.shift(); st.lows.shift(); }

        // Morgennachricht (08:00) — nur EINMAL pro Tag
        resetDailyFlagsIfNeeded();
        if (berlinMinutesOfDay() >= T.MORNING && !dailyFlags.morningSent) {
          dailyFlags.morningSent = true;
          await sendTelegram(buildMorningMsg());
          console.log('☀️ Morgennachricht gesendet');
        }

        // Session-Start-Pings (global, je einmal pro Tag)
        {
          const tm = berlinMinutesOfDay();
          if (tm >= T.ASIA_START && tm < T.ASIA_END && !dailyFlags.asiaPinged) {
            dailyFlags.asiaPinged = true;
            await sendTelegram(buildSessionMsg('🌏', 'Asia', '02:00 – 09:00'));
            console.log('🌏 Asia-Session-Ping gesendet');
          } else if (tm >= T.ASIA_END && tm < T.NYC_OPEN && !dailyFlags.londonPinged) {
            dailyFlags.londonPinged = true;
            await sendTelegram(buildSessionMsg('🏙', 'London', '09:00 – 15:30'));
            console.log('🏙 London-Session-Ping gesendet');
          } else if (tm >= T.NYC_OPEN && tm < T.NYC_CLOSE && !dailyFlags.nyPinged) {
            dailyFlags.nyPinged = true;
            await sendTelegram(buildSessionMsg('🗽', 'New York', '15:30 – 22:00'));
            console.log('🗽 New York-Session-Ping gesendet');
          }
        }

        // 0. Offene Trades prüfen (TP/SL/Timeout)
        await checkOpenTrades(normSym, high, low);

        // ─── SWING 1H aus dem 1M-Feed (Weg 2) ───────────────────────────
        // Läuft nur für echte 1M-Scalp-Feeds, nicht für evtl. Alt-_SWING-Alerts.
        if (!isSwing(symbol) && sessionKey) {
          const swingKey = `${sessionKey}_SWING`;

          // 1) Offenen Swing-Trade bei JEDEM 1M-Tick auf TP/SL prüfen
          await checkOpenTrades(swingKey, high, low);

          // 2) 1H-Kerze fortschreiben; bei Stundenschluss Swing-Strategie prüfen
          const finishedHour = feedSwingCandle(sessionKey, close, high, low);
          if (finishedHour) {
            saveState(); // Warmup-Fortschritt sofort sichern
            if (!hasOpenTrade(swingKey) && !inCooldown(swingKey)) {
              const sst = swingStore[sessionKey];
              const sw = runSwingStrategy(sst.closes, sst.highs, sst.lows);
              if (sw) {
                const sigKey = `${sw.signal}-${Math.round(sw.cur)}`;
                if (sst.lastSignal !== sigKey) {
                  sst.lastSignal = sigKey;
                  // (Nachricht folgt nach der Order — dann kennen wir die echte Lot)
                  const swTrade = {
                    symbol: swingKey, signal: sw.signal, entry: sw.cur,
                    sl: sw.sl, tp1: sw.tp1, tp2: sw.tp2, tp3: sw.tp3, rr: sw.rr, atr: sw.atr,
                    type: 'swing', timeoutMin: CONFIG.SWING_TIMEOUT_MIN, openedAt: Date.now(),
                  };
                  openTrades.push(swTrade);
                  const swEx = tradingPaused()
                    ? { positionId: 'DRY-' + Date.now(), brokerEntry: sw.cur }   // Pause: virtuell tracken, keine echte Order
                    : await broker.openTrade({ sessionKey, signal: sw.signal, entry: sw.cur, sl: sw.sl, tp: sw.tp3, type: 'swing', tag: swingKey });
                  if (swEx) { swTrade.positionId = swEx.positionId; swTrade.brokerEntry = swEx.brokerEntry; swTrade.lot = swEx.volume; }
                  await sendTelegram(buildSwingSignalMsg(
                    sw.signal, assetLabel, sw.cur, sw.sl, sw.tp1, sw.tp2, sw.tp3, sw.rr, sw.rsi, sw.trend, swTrade.lot
                  ));
                  logSignal({ time: getBerlinTime(), symbol: assetLabel, signal: sw.signal, type: 'Swing', grade: null, entry: sw.cur });
                  lastTradeTime[swingKey] = Date.now();
                  console.log(`🟠 Swing (1H aus 1M): ${sw.signal} ${assetLabel} (${sw.trend})`);
                }
              }
            }
          }
        }

        // (Alt-Pfad: nur falls doch noch ein _SWING-Alert reinkommt — normalerweise inaktiv)
        if (isSwing(symbol)) {
          if (!hasOpenTrade(normSym) && !inCooldown(normSym)) {
            const sw = runSwingStrategy(st.closes, st.highs, st.lows);
            if (sw) {
              const signalKey = `${sw.signal}-${Math.round(sw.cur)}`;
              if (st.lastSignal !== signalKey) {
                st.lastSignal = signalKey;
                await sendTelegram(buildSwingSignalMsg(sw.signal, assetLabel, sw.cur, sw.sl, sw.tp1, sw.tp2, sw.tp3, sw.rr, sw.rsi, sw.trend));
                openTrades.push({ symbol: normSym, signal: sw.signal, entry: sw.cur, sl: sw.sl, tp1: sw.tp1, tp2: sw.tp2, tp3: sw.tp3, rr: sw.rr, type: 'swing', timeoutMin: CONFIG.SWING_TIMEOUT_MIN, openedAt: Date.now() });
                logSignal({ time: getBerlinTime(), symbol: assetLabel, signal: sw.signal, type: 'Swing', grade: null, entry: sw.cur });
                lastTradeTime[normSym] = Date.now();
                console.log(`🟠 Swing (Alt-Alert): ${sw.signal} ${assetLabel} (${sw.trend})`);
              }
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, signal: 'WAIT', type: 'swing', candles: st.closes.length }));
        }

        if (sd) {
          resetDayIfNeeded(sd);
          updateSessions(sd, high, low);
          const t = berlinMinutesOfDay();

          // 1. Daily Bias (15:30) — nur einmal
          if (t >= T.NYC_OPEN && !sd.biasSent) {
            const b = calcDailyBias(sd);
            if (b) {
              sd.biasSent = true;
              sd.lastBias = b.bias;
              await sendTelegram(buildBiasMsg(assetLabel, b.bias, b.reason, b.asiaHigh, b.asiaLow));
              console.log(`🔵 Bias: ${b.bias} ${assetLabel}`);
            }
          }

          // 2. Opening Range (15:45) — nur einmal
          if (CONFIG.ENABLE_OPENING_RANGE && t >= T.RANGE_END && !sd.openingRange.sent && sd.openingRange.high !== null) {
            sd.openingRange.sent = true;
            await sendTelegram(buildOpeningRangeMsg(assetLabel, sd.openingRange.high, sd.openingRange.low));
            console.log(`🟣 Opening Range ${assetLabel}`);
          }

          // 3. Opening Range Breakout — nur einmal, nur wenn kein offener Trade
          if (CONFIG.ENABLE_OPENING_RANGE && sd.openingRange.sent && !sd.openingRange.breakoutSent && !hasOpenTrade(normSym)) {
            const bo = checkOpeningRangeBreakout(sd, close);
            if (bo) {
              sd.openingRange.breakoutSent = true;
              const atrV = atrCalc(st.closes, st.highs, st.lows) || close * 0.005;
              const d = bo === 'BUY' ? 1 : -1;
              const sl = parseFloat((close - d * atrV * CONFIG.SL_MULT).toFixed(2));
              const tp1 = parseFloat((close + d * atrV * CONFIG.TP1_MULT).toFixed(2));
              const tp2 = parseFloat((close + d * atrV * CONFIG.TP2_MULT).toFixed(2));
              const tp3 = parseFloat((close + d * atrV * CONFIG.TP3_MULT).toFixed(2));
              const rr = (CONFIG.TP1_MULT / CONFIG.SL_MULT).toFixed(2);
              const trend15m = get15MTrend(st.closes, st.highs, st.lows);
              const orTrade = { symbol: normSym, signal: bo, entry: parseFloat(close.toFixed(2)), sl, tp1, tp2, tp3, rr, atr: atrV, type: 'opening_range', openedAt: Date.now() };
              openTrades.push(orTrade);
              const orEx = tradingPaused()
                ? { positionId: 'DRY-' + Date.now(), brokerEntry: parseFloat(close.toFixed(2)) }   // Pause: nur tracken
                : await broker.openTrade({ sessionKey, signal: bo, entry: parseFloat(close.toFixed(2)), sl, tp: tp3, type: 'opening_range', tag: normSym });
              if (orEx) { orTrade.positionId = orEx.positionId; orTrade.brokerEntry = orEx.brokerEntry; orTrade.lot = orEx.volume; }
              await sendTelegram(buildOpeningRangeSignalMsg(bo, assetLabel, close, sl, tp1, tp2, tp3, rr, sd.lastBias, trend15m, orTrade.lot));
              logSignal({ time: getBerlinTime(), symbol: assetLabel, signal: bo, type: 'Opening Range', grade: null, entry: parseFloat(close.toFixed(2)) });
              lastTradeTime[normSym] = Date.now();
              console.log(`🟣 Breakout: ${bo} ${assetLabel}`);
            }
          }

          // 4. Tages-Report (22:00) — nur einmal
          if (t >= T.REPORT && !sd.reportSent) {
            sd.reportSent = true;
            await sendTelegram(buildPerformanceReport(assetLabel, sd.performance, sessionKey));
            console.log(`📊 Report ${assetLabel}`);
          }

          // 4b. Wochen-Report (Freitag ab 22:00) — nur einmal pro Woche, global
          if (berlinWeekday() === 5 && t >= T.REPORT && weeklyReport.lastSent !== getBerlinDate()) {
            weeklyReport.lastSent = getBerlinDate();
            await sendTelegram(buildWeeklyReport());
            console.log('📅 Wochen-Report gesendet');
          }
        }

        // 5. 4-Confirm Signal (Scalp) — nur wenn kein offener Trade UND kein Cooldown
        if (!hasOpenTrade(normSym) && !inCooldown(normSym)) {
          const result = runStrategy(st.closes, st.highs, st.lows, sessionKey);
          if (result) {
            const bias = sd?.lastBias || null;
            const biasBlocks = getFilters(sessionKey).requireBiasAlign
              && bias && bias !== 'WATCH' && bias !== 'NEUTRAL'
              && bias !== result.signal;

            const signalKey = `${result.signal}-${Math.round(result.cur)}`;
            if (!biasBlocks && st.lastSignal !== signalKey) {
              st.lastSignal = signalKey;
              const trend15m = get15MTrend(st.closes, st.highs, st.lows);
              const scTrade = { symbol: normSym, signal: result.signal, entry: result.cur, sl: result.sl, tp1: result.tp1, tp2: result.tp2, tp3: result.tp3, rr: result.rr, atr: result.atr, type: '4confirm', grade: result.grade, openedAt: Date.now() };
              openTrades.push(scTrade);
              const scEx = tradingPaused()
                ? { positionId: 'DRY-' + Date.now(), brokerEntry: result.cur }   // Pause: nur tracken
                : await broker.openTrade({ sessionKey, signal: result.signal, entry: result.cur, sl: result.sl, tp: result.tp3, type: 'scalp', tag: normSym });
              if (scEx) { scTrade.positionId = scEx.positionId; scTrade.brokerEntry = scEx.brokerEntry; scTrade.lot = scEx.volume; }
              await sendTelegram(buildSignalMsg(result.signal, assetLabel, result.cur, result.sl, result.tp1, result.tp2, result.tp3, result.rr, result.rsi, result.macd, bias, trend15m, result.liqTarget, result.sweptLiquidity, result.grade, result.score, result.factors, scTrade.lot));
              logSignal({ time: getBerlinTime(), symbol: assetLabel, signal: result.signal, type: 'Scalp', grade: result.grade, entry: result.cur });
              lastTradeTime[normSym] = Date.now();
              console.log(`${result.signal === 'BUY' ? '🟢' : '🔴'} Signal: ${result.signal} ${assetLabel}`);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ ok: true, signal: result.signal, entry: result.cur }));
            } else if (biasBlocks) {
              console.log(`⏸ ${result.signal} ${assetLabel} blockiert (gegen Bias ${bias})`);
            }
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, signal: 'WAIT', candles: st.closes.length, openTrades: openTrades.length }));
      } catch (e) {
        console.error('❌ Webhook Fehler:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  loadState(); // gespeicherten Swing-Warmup + offene Trades laden (falls Volume vorhanden)
  broker.init().catch(e => console.warn('Broker init:', e.message)); // MT5-Verbindung aufbauen
  console.log(`🚀 Apex Signal Bot v4 läuft auf Port ${PORT}`);
  console.log(`📊 Config: SL ${CONFIG.SL_MULT}×ATR · TP1/2/3 = ${CONFIG.TP1_MULT}/${CONFIG.TP2_MULT}/${CONFIG.TP3_MULT}×ATR · Swing EMA${CONFIG.SWING_EMA_SLOW} (risikobasiert)`);
  if (!TOKEN) console.warn('⚠️  BOT_TOKEN nicht gesetzt!');
});

// State periodisch sichern (alle 30s) + sauber beim Herunterfahren (Railway-Redeploy)
setInterval(saveState, 30000);
setInterval(tradingPaused, 60000); // abgelaufene Trading-Pause selbsttätig beenden
function gracefulExit() { try { saveState(); } catch (_) {} process.exit(0); }
process.on('SIGTERM', gracefulExit);
process.on('SIGINT', gracefulExit);
