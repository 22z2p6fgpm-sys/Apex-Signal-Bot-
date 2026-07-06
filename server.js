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

  MAX_CANDLES: 300,
  TRADE_TIMEOUT_MIN: 240, // 4h
  RSI_BUY: [45, 65],
  RSI_SELL: [35, 55],

  // ── Qualitäts-Filter ──
  COOLDOWN_MIN: 15,
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
  SWING_SL_MULT: 2,
  SWING_TP1_MULT: 2.0,
  SWING_TP2_MULT: 4.0,
  SWING_TP3_MULT: 6.0,
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
    cooldownMin: 30,
    requireBiasAlign: true,
    require15mAlign: true,
    require4hAlign: true,
    require5mAlign: true,
    requireBOS: false,
    requireLiquidity: true,
    sweepBoost: true,
  },
  'XAUUSD': {
    minAtrPercent: CONFIG.MIN_ATR_PERCENT,
    rsiBuy: CONFIG.RSI_BUY,
    rsiSell: CONFIG.RSI_SELL,
    cooldownMin: CONFIG.COOLDOWN_MIN,
    requireBiasAlign: CONFIG.REQUIRE_BIAS_ALIGN,
    require15mAlign: false,
    require4hAlign: true,
    require5mAlign: true,
    requireBOS: false,
    requireLiquidity: true,
    sweepBoost: true,
  },
};
function getFilters(sessionKey) {
  return SYMBOL_FILTERS[sessionKey] || SYMBOL_FILTERS['XAUUSD'];
}

// ── Pip- & Geldwert-Definitionen pro Symbol ──
// Gold: 1 Pip = 0.1 Preis-Einheiten. NASDAQ: 1 Pip = 1 Punkt.
// moneyPerPipPerLot = USD pro Pip bei 0.01 Referenz-Lot. Skaliert über LOT_SIZE.
const PIP_INFO = {
  'XAUUSD': { pipSize: 0.1, moneyPerPipPerLot: 0.10 },
  'NDX':    { pipSize: 1.0, moneyPerPipPerLot: 0.20 },
};
const LOT_SIZE = 1;   // von 0.01 → 1.0 (volles Lot). Faktor (LOT_SIZE/0.01) = ×100.

// Wandelt eine Preis-Differenz in Pips + Geldwert um
function toPipsAndMoney(sessionKey, priceDiff) {
  const info = PIP_INFO[sessionKey] || { pipSize: 1, moneyPerPipPerLot: 1 };
  const pips = priceDiff / info.pipSize;
  const money = pips * info.moneyPerPipPerLot * (LOT_SIZE / 0.01);
  return { pips, money };
}

// Formatiert PnL als "+12.5 Pips (+$1.25)"
function fmtPnl(sessionKey, priceDiff) {
  const { pips, money } = toPipsAndMoney(sessionKey, priceDiff);
  const sign = priceDiff >= 0 ? '+' : '';
  return `${sign}${pips.toFixed(1)} Pips (${sign}$${money.toFixed(2)})`;
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

  const buyS = crossUp && rsiBuy && mBull && cur > s50;
  const sellS = crossDown && rsiSell && mBear && cur < s50;
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

  const t4hGrade = getTrendOnTF(closes, highs, lows, 240);
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

const dailyFlags = { date: null, morningSent: false };
function resetDailyFlagsIfNeeded() {
  const today = getBerlinDate();
  if (dailyFlags.date !== today) {
    dailyFlags.date = today;
    dailyFlags.morningSent = false;
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
  sd.performance.trades.push({ signal: trade.signal, entry: trade.entry, result, pnl, time: getBerlinTime() });
}

// ─── OPEN TRADES TRACKER ────────────────────────────────────────────────────
const openTrades = [];
const signalLog = [];
function logSignal(entry) {
  signalLog.unshift(entry);
  if (signalLog.length > 30) signalLog.pop();
}
const lastTradeTime = {};

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

async function checkOpenTrades(symbol, high, low) {
  const sessionKey = getSessionKey(symbol);
  const assetLabel = getAssetLabel(symbol);
  const sd = sessionKey ? sessionData[sessionKey] : null;
  const now = Date.now();
  const remaining = [];

  for (const trade of openTrades) {
    if (trade.symbol !== symbol) { remaining.push(trade); continue; }

    const isBuy = trade.signal === 'BUY';
    const typeLabel = trade.type === 'opening_range' ? 'Opening Range' : trade.type === 'swing' ? '🟠 Swing' : '4-Confirm';
    const dirEmoji = isBuy ? '📈' : '📉';
    const reached = (level) => isBuy ? high >= level : low <= level;

    if (!trade.tp1Hit && reached(trade.tp1)) {
      trade.tp1Hit = true;
      const pnl = Math.abs(trade.tp1 - trade.entry);
      if (sd) recordTrade(sd, trade, 'WIN', pnl);
      const total = sd ? sd.performance.wins + sd.performance.losses : 0;
      const winRate = total > 0 ? ((sd.performance.wins / total) * 100).toFixed(1) : '0';
      await sendTelegram(`🎯 *TP1 HIT — ${assetLabel}* ✅

${dirEmoji} ${trade.signal} · ${typeLabel}
💰 Entry: \`${trade.entry.toFixed(2)}\`
🎯 TP1 erreicht: \`${trade.tp1.toFixed(2)}\`
💵 +\`${fmtPnl(sessionKey, Math.abs(trade.tp1 - trade.entry))}\` gesichert

✅ *Trade zählt als WIN!* Läuft weiter Richtung TP2.
🔜 Nächstes Ziel: \`${trade.tp2.toFixed(2)}\`

🔥 Serie: \`${sd ? sd.performance.streak : 0}× ${sd ? (sd.performance.streakType || '-') : '-'}\`
📊 Heute: \`${sd ? sd.performance.wins : 0}W / ${sd ? sd.performance.losses : 0}L\` · Win-Rate \`${winRate}%\`
⚡ _Apex Signal Bot_`);
      console.log(`🎯 TP1 HIT: ${trade.signal} ${assetLabel}`);
    }

    if (trade.tp1Hit && !trade.tp2Hit && reached(trade.tp2)) {
      trade.tp2Hit = true;
      if (CONFIG.BREAKEVEN_AFTER_TP2) { trade.sl = trade.entry; await broker.moveToBreakeven(trade.positionId, trade.entry, trade.tp3); }
      await sendTelegram(`🎯 *TP2 HIT — ${assetLabel}* ✅

${dirEmoji} ${trade.signal} · ${typeLabel}
🎯 TP2 erreicht: \`${trade.tp2.toFixed(2)}\`
💵 +\`${fmtPnl(sessionKey, Math.abs(trade.tp2 - trade.entry))}\`
${CONFIG.BREAKEVEN_AFTER_TP2 ? '🛡 *SL jetzt auf Break-Even* — Rest läuft risikofrei!' : ''}
🔜 Letztes Ziel: \`${trade.tp3.toFixed(2)}\`
⚡ _Apex Signal Bot_`);
      console.log(`🎯 TP2 HIT: ${trade.signal} ${assetLabel} → Break-Even`);
    }

    if (trade.tp2Hit && reached(trade.tp3)) {
      await sendTelegram(`🎯 *TP3 HIT — ${assetLabel}* 🏆

${dirEmoji} ${trade.signal} · ${typeLabel}
🎯 TP3 erreicht: \`${trade.tp3.toFixed(2)}\`
💵 +\`${fmtPnl(sessionKey, Math.abs(trade.tp3 - trade.entry))}\` — *voll durchgelaufen!* 🚀
✅ Trade abgeschlossen.
⚡ _Apex Signal Bot_`);
      console.log(`🏆 TP3 HIT: ${trade.signal} ${assetLabel} — geschlossen`);
      await broker.closeTrade(trade.positionId);
      continue;
    }

    const slHit = isBuy ? low <= trade.sl : high >= trade.sl;
    if (slHit) {
      const atBreakeven = trade.tp1Hit && trade.sl === trade.entry;
      if (atBreakeven) {
        await sendTelegram(`🛡 *BREAK-EVEN STOP — ${assetLabel}*

${dirEmoji} ${trade.signal} · ${typeLabel}
Position bei Entry \`${trade.entry.toFixed(2)}\` geschlossen.
✅ Gewinne aus TP1${trade.tp2Hit ? '/TP2' : ''} sind gesichert — kein Verlust.
⚡ _Apex Signal Bot_`);
        console.log(`🛡 Break-Even Stop: ${trade.signal} ${assetLabel}`);
      } else {
        const pnl = -Math.abs(trade.entry - trade.sl);
        if (sd && !trade.tp1Hit) recordTrade(sd, trade, 'LOSS', pnl);
        const total = sd ? sd.performance.wins + sd.performance.losses : 0;
        const winRate = total > 0 ? ((sd.performance.wins / total) * 100).toFixed(1) : '0';
        await sendTelegram(`❌ *TRADE LOSS — ${assetLabel}*

${dirEmoji} ${trade.signal} · ${typeLabel}
💰 Entry: \`${trade.entry.toFixed(2)}\`
🛑 SL erreicht: \`${trade.sl.toFixed(2)}\`
💵 \`${fmtPnl(sessionKey, -Math.abs(trade.entry - trade.sl))}\`

🔥 Serie: \`${sd ? sd.performance.streak : 0}× ${sd ? (sd.performance.streakType || '-') : '-'}\`
📊 Heute: \`${sd ? sd.performance.wins : 0}W / ${sd ? sd.performance.losses : 0}L\` · Win-Rate \`${winRate}%\`
⚡ _Apex Signal Bot_`);
        console.log(`❌ LOSS: ${trade.signal} ${assetLabel}`);
      }
      await broker.closeTrade(trade.positionId);
      continue;
    }

    const timeoutMin = trade.timeoutMin || CONFIG.TRADE_TIMEOUT_MIN;
    if ((now - trade.openedAt) > timeoutMin * 60 * 1000) {
      if (!trade.tp1Hit) {
        await sendTelegram(`⏱ *TIMEOUT — ${assetLabel}*

${dirEmoji} ${trade.signal} · ${typeLabel}
Trade nach Zeitlimit geschlossen (kein TP/SL erreicht).
💰 Entry war \`${trade.entry.toFixed(2)}\`
⚡ _Apex Signal Bot_`);
        console.log(`⏱ TIMEOUT: ${trade.signal} ${assetLabel}`);
      }
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
function biasTag(bias, signal) {
  if (!bias || bias === 'WATCH' || bias === 'NEUTRAL') return '';
  return bias === signal ? '\n✅ *Mit Daily Bias* — starkes Signal!' : '\n⚠️ *HIGH RISK* — gegen Daily Bias!';
}
function tf15Tag(trend15m, signal) {
  if (!trend15m) return '• 15M Trend: neutral';
  return trend15m === signal ? '• ✅ 15M Trend bestätigt' : '• ⚠️ Gegen 15M Trend';
}

function buildMorningMsg() {
  return `☀️ *GUTEN MORGEN!*

✅ Apex Signal Bot ist *aktiv* und überwacht die Märkte.
🗓 ${getBerlinDate()}

📡 *Heute im Blick:*
• XAU/USD (Gold) — Scalp & Swing
• NASDAQ 100 — Scalp & Swing

🔵 Daily Bias kommt um *15:30*
🟣 Opening Range um *15:45*
📊 Tages-Report um *22:00*

_Auf einen profitablen Tag!_ 💪
⚡ _Apex Signal Bot_`;
}

function buildBiasMsg(asset, bias, reason, asiaHigh, asiaLow) {
  const t = bias === 'BUY' ? '📈 BULLISH' : bias === 'SELL' ? '📉 BEARISH' : bias === 'WATCH' ? '👀 WATCH' : '➡️ NEUTRAL';
  return `🔵 *DAILY BIAS — ${asset}*

📊 *Richtung:* ${t}
🗓 ${getBerlinDate()}

🌏 *Asia Range:*
• High: \`${asiaHigh.toFixed(2)}\`
• Low:  \`${asiaLow.toFixed(2)}\`

💡 ${reason}

⏰ _NYC Session startet!_
⚡ _Apex Signal Bot_`;
}

function buildOpeningRangeMsg(asset, high, low) {
  return `🟣 *NYC OPENING RANGE — ${asset}*

📐 High: \`${high.toFixed(2)}\`
📐 Low:  \`${low.toFixed(2)}\`
📏 Größe: \`${(high - low).toFixed(2)} pts\`

⏳ _Warte auf Ausbruch..._
🕐 _${getBerlinTime()}_
⚡ _Apex Signal Bot_`;
}

function buildOpeningRangeSignalMsg(signal, asset, entry, sl, tp1, tp2, tp3, rr, bias, trend15m) {
  const dir = signal === 'BUY' ? '📈' : '📉';
  return `🟣 *OPENING RANGE BREAKOUT — ${asset}* ${dir}${biasTag(bias, signal)}

💰 *Entry:*     \`${entry.toFixed(2)}\`
🛑 *Stop Loss:* \`${sl.toFixed(2)}\`

🎯 *TP1:* \`${tp1.toFixed(2)}\`  _(= WIN, sichern)_
🎯 *TP2:* \`${tp2.toFixed(2)}\`  _(→ Break-Even)_
🎯 *TP3:* \`${tp3.toFixed(2)}\`  _(Runner)_
⚖️ *R:R (bis TP1):* \`1 : ${rr}\`

📊 ${tf15Tag(trend15m, signal)}

🕐 _${getBerlinTime()}_
⚡ _Apex Signal Bot — Opening Range_`;
}

function buildSignalMsg(signal, asset, entry, sl, tp1, tp2, tp3, rr, rsi, macd, bias, trend15m, liqTarget, swept, grade, score, factors) {
  const emoji = signal === 'BUY' ? '🟢' : '🔴';
  const dir = signal === 'BUY' ? '📈' : '📉';
  const liqLine = liqTarget ? `\n💧 *Liquiditäts-Ziel:* \`${liqTarget.toFixed(2)}\`` : '';
  const sweepLine = swept ? `\n🎯 *Liquidity Sweep erkannt!* _(Stop-Hunt + Umkehr — starkes Setup)_` : '';

  let gradeBox = '';
  if (factors) {
    const chk = (b) => b ? '✅' : '⬜️';
    const gradeEmoji = grade === 'A+' ? '🏆' : grade === 'A' ? '⭐️' : grade === 'B' ? '👍' : '⚠️';
    gradeBox = `

${gradeEmoji} *Setup-Grade: ${grade}* _(${score}/6)_
${chk(factors.sweep)} Liquidity Sweep
${chk(factors.liquidity)} Klares Ziel
${chk(factors.biasAlign)} 4H Bias
${chk(factors.entryAlign)} 15M Entry
${chk(factors.fvg)} Fair Value Gap
${chk(factors.strongCandle)} Starke Kerze`;
  }

  return `${emoji} *${signal} NOW* — ${asset} ${dir}${biasTag(bias, signal)}${sweepLine}${gradeBox}

💰 *Entry:*     \`${entry.toFixed(2)}\`
🛑 *Stop Loss:* \`${sl.toFixed(2)}\`

🎯 *TP1:* \`${tp1.toFixed(2)}\`  _(= WIN, sichern)_
🎯 *TP2:* \`${tp2.toFixed(2)}\`  _(→ Break-Even)_
🎯 *TP3:* \`${tp3.toFixed(2)}\`  _(Runner)_
⚖️ *R:R (bis TP1):* \`1 : ${rr}\`${liqLine}

📊 *Indikatoren:*
• RSI 14: \`${rsi}\`
• MACD: \`${macd}\`
${tf15Tag(trend15m, signal)}

🕐 _${getBerlinTime()} — ${getBerlinDate()}_
⚡ _Apex Signal Bot — Conservative Scalp_`;
}

function buildSwingSignalMsg(signal, asset, entry, sl, tp1, tp2, tp3, rr, rsi, trend) {
  const dir = signal === 'BUY' ? '📈' : '📉';
  return `🟠 *SWING ${signal}* — ${asset} ${dir}

⏳ _Haltedauer: Stunden bis 1 Tag · 1H Chart_
📐 _Setup: Trend-Following + Pullback_

💰 *Entry:*     \`${entry.toFixed(2)}\`
🛑 *Stop Loss:* \`${sl.toFixed(2)}\`

🎯 *TP1:* \`${tp1.toFixed(2)}\`  _(= WIN, sichern)_
🎯 *TP2:* \`${tp2.toFixed(2)}\`  _(→ Break-Even)_
🎯 *TP3:* \`${tp3.toFixed(2)}\`  _(Runner)_
⚖️ *R:R (bis TP1):* \`1 : ${rr}\`

📊 *Analyse (1H):*
• Trend: \`${trend}\`
• RSI 14: \`${rsi}\`
• Pullback zur EMA20 ✅

🕐 _${getBerlinTime()} — ${getBerlinDate()}_
⚡ _Apex Signal Bot — Swing Trade_`;
}

function buildPerformanceReport(asset, perf, sessionKey) {
  const total = perf.wins + perf.losses;
  const winRate = total > 0 ? ((perf.wins / total) * 100).toFixed(1) : '0';
  const totalPnlPrice = perf.trades.reduce((a, t) => a + t.pnl, 0);
  const totalFmt = fmtPnl(sessionKey, totalPnlPrice);
  const se = perf.streakType === 'WIN' ? '🔥' : perf.streakType === 'LOSS' ? '❄️' : '➡️';
  const last = perf.trades.slice(-5).map(t => {
    const { pips } = toPipsAndMoney(sessionKey, t.pnl);
    return `${t.result === 'WIN' ? '✅' : '❌'} ${t.signal} · ${pips > 0 ? '+' : ''}${pips.toFixed(1)} Pips`;
  }).join('\n') || 'Keine abgeschlossenen Trades heute';

  return `📊 *TAGES-REPORT — ${asset}*
🗓 ${getBerlinDate()}

*Performance:*
✅ Wins: \`${perf.wins}\`  ❌ Losses: \`${perf.losses}\`
📈 Win-Rate: \`${winRate}%\`
💰 Total: \`${totalFmt}\`

*Streak:*
${se} Aktuell: \`${perf.streak}× ${perf.streakType || '-'}\`
🏆 Beste Win-Serie: \`${perf.bestStreak}×\`
📉 Schlimmste Loss-Serie: \`${perf.worstStreak}×\`

*Letzte Trades:*
${last}

⚡ _Apex Signal Bot — Daily Report_`;
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

function saveState() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const state = { v: 1, savedAt: Date.now(), swingStore, swingBuilder, openTrades, lastTradeTime };
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
    const age = s.savedAt ? Math.round((Date.now() - s.savedAt) / 1000) : '?';
    console.log(`✅ State geladen: ${swingStore['XAUUSD'].closes.length} XAU / ${swingStore['NDX'].closes.length} NDX Swing-Kerzen · ${openTrades.length} offene Trades (vor ${age}s gesichert)`);
  } catch (e) {
    console.warn('⚠️ State laden fehlgeschlagen:', e.message);
  }
}

// ─── SERVER ────────────────────────────────────────────────────────────────────
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="de"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Apex Signal Bot</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0A0612;--bg2:#0F0A1E;--panel:#15102A;--panel2:#1A1438;
  --border:#2A2150;--accent:#A855F7;--accent2:#7C3AED;
  --text:#E2DAF5;--muted:#7A6CA8;--green:#34F5C5;--red:#FF5C7C;--gold:#FFD060;--blue:#8B9CFF;
}
body{background:linear-gradient(160deg,#0A0612,#0F0A1E 60%);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh}
.wrap{display:flex;min-height:100vh}
/* Sidebar */
.side{width:200px;background:var(--bg2);border-right:1px solid var(--border);padding:18px 12px;flex-shrink:0}
.brand{display:flex;align-items:center;gap:9px;margin-bottom:6px}
.logo{width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,#A855F7,#EC4899);display:flex;align-items:center;justify-content:center;font-size:16px}
.brandname{font-weight:800;font-size:15px;letter-spacing:.05em}
.brandsub{font-size:9px;color:var(--muted);letter-spacing:.2em;margin-bottom:20px;padding-left:2px}
.navitem{display:flex;align-items:center;gap:10px;padding:10px 11px;border-radius:9px;color:var(--muted);font-size:13px;font-weight:600;cursor:pointer;margin-bottom:3px;transition:.15s}
.navitem:hover{background:var(--panel)}
.navitem.active{background:linear-gradient(90deg,rgba(168,85,247,.25),transparent);color:var(--text);border-left:2px solid var(--accent)}
.navi{width:16px;text-align:center}
.statuspill{margin-top:18px;padding:9px 11px;background:rgba(52,245,197,.08);border:1px solid rgba(52,245,197,.25);border-radius:9px;font-size:11px;color:var(--green);font-weight:600;text-align:center}
/* Main */
.main{flex:1;padding:22px 26px;overflow-y:auto}
.tophead{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;flex-wrap:wrap;gap:10px}
.h1{font-size:26px;font-weight:800}
.h1 .eng{font-size:12px;color:var(--green);font-weight:600;margin-left:8px}
.subtitle{font-size:12px;color:var(--muted);margin-bottom:22px}
.tabs{display:flex;gap:8px;margin-bottom:20px}
.tab{padding:8px 18px;background:var(--panel);border:1px solid var(--border);border-radius:9px;color:var(--muted);cursor:pointer;font-weight:700;font-size:13px}
.tab.active{background:linear-gradient(135deg,var(--accent2),var(--accent));color:#fff;border-color:transparent}
.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:18px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:17px 18px;position:relative;overflow:hidden}
.card.big{grid-column:span 2}
.clabel{font-size:10px;color:var(--muted);letter-spacing:.12em;text-transform:uppercase;margin-bottom:8px}
.cval{font-size:30px;font-weight:800;line-height:1}
.csub{font-size:11px;color:var(--muted);margin-top:7px}
.green{color:var(--green)}.red{color:var(--red)}.blue{color:var(--blue)}.gold{color:var(--gold)}.white{color:var(--text)}
/* Equity curve */
.equity{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:18px;margin-bottom:18px}
.equityhead{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.equitytitle{font-size:13px;font-weight:700}
svg{width:100%;height:120px;display:block}
.sect{font-size:11px;color:var(--muted);letter-spacing:.18em;text-transform:uppercase;margin:22px 0 11px;font-weight:700}
.open{background:var(--panel);border:1px solid var(--border);border-left:3px solid var(--gold);border-radius:11px;padding:12px 15px;margin-bottom:7px;font-size:13px;display:flex;justify-content:space-between;align-items:center}
.gradeTag{display:inline-block;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:800;margin-left:7px}
.gA{background:rgba(52,245,197,.18);color:var(--green)}
.gB{background:rgba(139,156,255,.18);color:var(--blue)}
.gC{background:rgba(255,92,124,.15);color:var(--red)}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--border);border-radius:14px;overflow:hidden}
th{background:var(--panel2);color:var(--muted);font-size:10px;letter-spacing:.1em;text-transform:uppercase;padding:11px 13px;text-align:left}
td{padding:11px 13px;border-top:1px solid var(--border);font-size:13px}
.buy{color:var(--green);font-weight:700}.sell{color:var(--red);font-weight:700}
.muted{color:var(--muted)}.empty{text-align:center;padding:26px;color:var(--muted)}
.foot{text-align:center;margin-top:20px;font-size:10px;color:var(--muted);opacity:.6}
.hidden{display:none}
.stratcard{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:16px 18px;margin-bottom:12px}
.stratrow{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border);font-size:13px}
.stratrow:last-child{border-bottom:none}
.stratrow .k{color:var(--muted)}
.stratrow .v{font-weight:700}
.sigitem{background:var(--panel);border:1px solid var(--border);border-radius:11px;padding:12px 15px;margin-bottom:7px;display:flex;justify-content:space-between;align-items:center;font-size:13px}
@media(max-width:680px){
  .side{width:54px;padding:14px 6px}
  .brandname,.brandsub,.navitem span:last-child,.statuspill{display:none}
  .navitem{justify-content:center;padding:11px 0}
  .main{padding:16px 14px}
  .card.big{grid-column:span 1}
}
</style></head><body>
<div class="wrap">
  <div class="side">
    <div class="brand"><div class="logo">⚡</div><div class="brandname">APEX</div></div>
    <div class="brandsub">SIGNAL BOT v4</div>
    <div class="navitem active" id="nav-dashboard" onclick="nav('dashboard')"><span class="navi">▦</span><span>Dashboard</span></div>
    <div class="navitem" id="nav-positions" onclick="nav('positions')"><span class="navi">📊</span><span>Positionen</span></div>
    <div class="navitem" id="nav-signals" onclick="nav('signals')"><span class="navi">📡</span><span>Signale</span></div>
    <div class="navitem" id="nav-history" onclick="nav('history')"><span class="navi">📈</span><span>Verlauf</span></div>
    <div class="navitem" id="nav-strategy" onclick="nav('strategy')"><span class="navi">⚙️</span><span>Strategie</span></div>
    <div class="statuspill" id="sidestatus">● ENGINE ONLINE</div>
  </div>
  <div class="main">
    <div class="tophead">
      <div>
        <div class="h1" id="pageTitle">Dashboard<span class="eng" id="engtime">· live</span></div>
        <div class="subtitle" id="pageSub">Live-Übersicht deines Portfolios, Signale & Bot-Status</div>
      </div>
    </div>

    <!-- Markt-Tabs (nur auf Dashboard/Verlauf sichtbar) -->
    <div class="tabs" id="markettabs">
      <div class="tab active" id="tab-combined" onclick="sw('combined')">🌐 Gesamt</div>
      <div class="tab" id="tab-gold" onclick="sw('gold')">🥇 XAU/USD</div>
      <div class="tab" id="tab-ndx" onclick="sw('ndx')">📊 NASDAQ</div>
    </div>

    <!-- SEITE: Dashboard -->
    <div class="page" id="page-dashboard">
      <div class="row" id="stats"></div>
      <div class="equity">
        <div class="equityhead"><div class="equitytitle">📈 Equity-Kurve <span class="muted" id="eqlabel"></span></div></div>
        <svg id="eqsvg" viewBox="0 0 600 120" preserveAspectRatio="none"></svg>
      </div>
      <div class="sect">Offene Positionen</div>
      <div id="opentrades"></div>
    </div>

    <!-- SEITE: Positionen -->
    <div class="page hidden" id="page-positions">
      <div class="sect">Alle offenen Positionen</div>
      <div id="posList"></div>
    </div>

    <!-- SEITE: Signale -->
    <div class="page hidden" id="page-signals">
      <div class="sect">Letzte Signale (mit Grade)</div>
      <div id="sigList"></div>
    </div>

    <!-- SEITE: Verlauf -->
    <div class="page hidden" id="page-history">
      <div class="sect">Trade-Historie · Pips & Geld bei 1.0 Lot</div>
      <table><thead><tr><th>Zeit</th><th>Richtung</th><th>Ergebnis</th><th>Pips</th><th>Geld</th></tr></thead>
      <tbody id="history"><tr><td colspan="5" class="empty">Lädt...</td></tr></tbody></table>
    </div>

    <!-- SEITE: Strategie -->
    <div class="page hidden" id="page-strategy">
      <div class="sect">Aktuelle Strategie-Einstellungen</div>
      <div id="stratView"></div>
    </div>

    <div class="foot">Aktualisiert alle 5s · Apex Signal Bot</div>
  </div>
</div>
<script>
let cur='combined', data=null, page='dashboard';
const PAGE_INFO={
  dashboard:['Dashboard','Live-Übersicht deines Portfolios, Signale & Bot-Status',true],
  positions:['Positionen','Alle aktuell offenen Trades',false],
  signals:['Signale','Die letzten gesendeten Signale mit Bewertung',false],
  history:['Verlauf','Deine komplette Trade-Historie',true],
  strategy:['Strategie','Aktuelle Filter- und Risiko-Einstellungen',false],
};
function nav(p){
  page=p;
  ['dashboard','positions','signals','history','strategy'].forEach(x=>{
    document.getElementById('nav-'+x).className='navitem'+(x===p?' active':'');
    document.getElementById('page-'+x).className='page'+(x===p?'':' hidden');
  });
  const info=PAGE_INFO[p];
  document.getElementById('pageTitle').innerHTML=info[0]+'<span class="eng" id="engtime">· '+(data?data.time:'live')+'</span>';
  document.getElementById('pageSub').textContent=info[1];
  document.getElementById('markettabs').style.display=info[2]?'flex':'none';
  render();
}
function sw(t){cur=t;['combined','gold','ndx'].forEach(x=>document.getElementById('tab-'+x).className='tab'+(x===t?' active':''));render();}
function card(label,val,cls,sub){return '<div class="card"><div class="clabel">'+label+'</div><div class="cval '+(cls||'')+'">'+val+'</div>'+(sub?'<div class="csub">'+sub+'</div>':'')+'</div>';}
function gradeTag(g){return g?'<span class="gradeTag '+(g[0]==='A'?'gA':g==='B'?'gB':'gC')+'">'+g+'</span>':'';}
function renderPositions(){
  const ot=data.openTrades;
  document.getElementById('posList').innerHTML=ot.length?ot.map(t=>
    '<div class="open"><span class="'+(t.signal==='BUY'?'buy':'sell')+'">'+t.signal+' · '+t.symbol+' · '+t.type+gradeTag(t.grade)+'</span><span class="muted">Entry '+t.entry+(t.tp1Hit?' · TP1✅':'')+(t.tp2Hit?' TP2🛡':'')+'</span></div>'
  ).join(''):'<div class="empty">Keine offenen Positionen</div>';
}
function renderSignals(){
  const s=data.signals||[];
  document.getElementById('sigList').innerHTML=s.length?s.map(x=>
    '<div class="sigitem"><span class="'+(x.signal==='BUY'?'buy':'sell')+'">'+x.signal+' · '+x.symbol+gradeTag(x.grade)+'</span><span class="muted">'+x.type+' · '+x.entry+' · '+x.time+'</span></div>'
  ).join(''):'<div class="empty">Noch keine Signale gesendet</div>';
}
function renderStrategy(){
  const s=data.strategy;if(!s){return;}
  const r=(k,v)=>'<div class="stratrow"><span class="k">'+k+'</span><span class="v">'+v+'</span></div>';
  document.getElementById('stratView').innerHTML=
    '<div class="stratcard"><div class="clabel">Risiko & Ziele</div>'+
      r('Stop Loss','1.3 × ATR')+r('TP1 / TP2 / TP3',s.tp1+' / '+s.tp2+' / '+s.tp3+' × ATR')+
      r('Cooldown',s.cooldown+' Min')+r('Min. ATR',s.minAtr+'%')+'</div>'+
    '<div class="stratcard"><div class="clabel">Session-Filter</div>'+
      r('Asia (strenger)',s.asia)+r('Abend (strenger)',s.evening)+'</div>'+
    '<div class="stratcard"><div class="clabel">🥇 Gold-Filter</div>'+
      r('Min. ATR',s.gold.minAtrPercent+'%')+r('4H-Bias',s.gold.require4hAlign?'✅':'—')+
      r('5M-Entry',s.gold.require5mAlign?'✅':'—')+r('Liquidität',s.gold.requireLiquidity?'✅':'—')+
      r('Sweep-Boost',s.gold.sweepBoost?'✅':'—')+'</div>'+
    '<div class="stratcard"><div class="clabel">📊 NASDAQ-Filter (strenger)</div>'+
      r('Min. ATR',s.ndx.minAtrPercent+'%')+r('Cooldown',s.ndx.cooldownMin+' Min')+
      r('15M-Align',s.ndx.require15mAlign?'✅':'—')+r('4H-Bias',s.ndx.require4hAlign?'✅':'—')+
      r('Liquidität',s.ndx.requireLiquidity?'✅':'—')+'</div>';
}
function render(){
  if(!data)return;
  if(page==='positions'){renderPositions();return;}
  if(page==='signals'){renderSignals();return;}
  if(page==='strategy'){renderStrategy();return;}
  if(page==='history'){renderHistory();return;}
  if(cur==='combined'){
    const c=data.combined;
    document.getElementById('stats').innerHTML=
      card('Gesamt-Gewinn',(c.money>=0?'+':'')+'$'+c.money,c.money>=0?'green':'red','beide Märkte zusammen')+
      card('Win-Rate',c.winRate+'%',parseFloat(c.winRate)>=50?'green':'red',c.wins+'W / '+c.losses+'L')+
      card('Total Pips',(c.pips>=0?'+':'')+c.pips,c.pips>=0?'green':'red')+
      card('Gold',(data.gold.totalMoney>=0?'+':'')+'$'+data.gold.totalMoney,data.gold.totalMoney>=0?'green':'red',data.gold.winRate+'% WR')+
      card('NASDAQ',(data.ndx.totalMoney>=0?'+':'')+'$'+data.ndx.totalMoney,data.ndx.totalMoney>=0?'green':'red',data.ndx.winRate+'% WR');
    drawEquity(mergeEquity(data.gold.equity,data.ndx.equity));
    document.getElementById('eqlabel').textContent='· Gesamt';
  } else {
    const d=data[cur];
    document.getElementById('stats').innerHTML=
      card('Win-Rate',d.winRate+'%',parseFloat(d.winRate)>=50?'green':'red',d.wins+'W / '+d.losses+'L')+
      card('Total Geld',(d.totalMoney>=0?'+':'')+'$'+d.totalMoney,d.totalMoney>=0?'green':'red')+
      card('Total Pips',(d.totalPips>=0?'+':'')+d.totalPips,d.totalPips>=0?'green':'red')+
      card('Serie',d.streak+'× '+(d.streakType||'-'),d.streakType==='WIN'?'green':d.streakType==='LOSS'?'red':'white','beste: '+d.bestStreak+'×')+
      card('Kerzen',d.candles,'blue','Swing: '+d.swingCandles+(d.swingCandles>=d.swingNeeded?' ✅':' / '+d.swingNeeded))+
      card('Bias',d.bias,'gold');
    drawEquity(d.equity);
    document.getElementById('eqlabel').textContent='· '+(cur==='gold'?'XAU/USD':'NASDAQ');
  }
  const ot=data.openTrades.filter(t=>cur==='combined'?true:(cur==='gold'?t.symbol.includes('XAU'):t.symbol.includes('NASDAQ')));
  document.getElementById('opentrades').innerHTML=ot.length?ot.map(t=>{
    return '<div class="open"><span class="'+(t.signal==='BUY'?'buy':'sell')+'">'+t.signal+' · '+t.type+gradeTag(t.grade)+'</span><span class="muted">Entry '+t.entry+(t.tp1Hit?' · TP1✅':'')+(t.tp2Hit?' TP2🛡':'')+'</span></div>';
  }).join(''):'<div class="empty">Keine offenen Positionen</div>';
}
function renderHistory(){
  const tr=cur==='combined'?[]:data[cur].trades;
  if(cur==='combined'){
    document.getElementById('history').innerHTML='<tr><td colspan="5" class="empty">Wähle oben einen Markt (XAU/USD oder NASDAQ)</td></tr>';
  } else {
    document.getElementById('history').innerHTML=tr.length?tr.map(t=>'<tr><td class="muted">'+t.time+'</td><td class="'+(t.signal==='BUY'?'buy':'sell')+'">'+t.signal+'</td><td>'+(t.result==='WIN'?'✅ WIN':'❌ LOSS')+'</td><td class="'+(t.pips>=0?'green':'red')+'">'+(t.pips>0?'+':'')+t.pips+'</td><td class="muted">'+(t.money>0?'+':'')+'$'+t.money+'</td></tr>').join(''):'<tr><td colspan="5" class="empty">Noch keine Trades</td></tr>';
  }
}
function mergeEquity(a,b){
  const n=Math.max(a.length,b.length);const out=[];
  const la=a.length?a[a.length-1]:0, lb=b.length?b[b.length-1]:0;
  for(let i=0;i<n;i++){out.push((a[i]??la)+(b[i]??lb));}
  return out;
}
function drawEquity(eq){
  const svg=document.getElementById('eqsvg');
  if(!eq||eq.length<2){svg.innerHTML='<text x="300" y="60" fill="#7A6CA8" font-size="12" text-anchor="middle">Noch nicht genug Daten</text>';return;}
  const min=Math.min(0,...eq),max=Math.max(0,...eq);
  const range=(max-min)||1;
  const W=600,H=120,pad=8;
  const pts=eq.map((v,i)=>{const x=pad+(i/(eq.length-1))*(W-2*pad);const y=H-pad-((v-min)/range)*(H-2*pad);return [x,y];});
  const line=pts.map((p,i)=>(i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1)).join(' ');
  const area=line+' L'+pts[pts.length-1][0].toFixed(1)+' '+(H-pad)+' L'+pad+' '+(H-pad)+' Z';
  const last=eq[eq.length-1];
  const col=last>=0?'#34F5C5':'#FF5C7C';
  const zeroY=H-pad-((0-min)/range)*(H-2*pad);
  svg.innerHTML=
    '<defs><linearGradient id="eg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="'+col+'" stop-opacity="0.35"/><stop offset="100%" stop-color="'+col+'" stop-opacity="0"/></linearGradient></defs>'+
    '<line x1="'+pad+'" y1="'+zeroY.toFixed(1)+'" x2="'+(W-pad)+'" y2="'+zeroY.toFixed(1)+'" stroke="#2A2150" stroke-width="1" stroke-dasharray="4 4"/>'+
    '<path d="'+area+'" fill="url(#eg)"/>'+
    '<path d="'+line+'" fill="none" stroke="'+col+'" stroke-width="2"/>';
}
async function refresh(){
  try{const r=await fetch('/data');data=await r.json();
    document.getElementById('engtime').textContent='· '+data.time;
    document.getElementById('sidestatus').textContent='● ENGINE ONLINE';
    render();
  }catch(e){document.getElementById('sidestatus').textContent='● OFFLINE';}
}
refresh();setInterval(refresh,5000);
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
      `Scalp: Cooldown ${CONFIG.COOLDOWN_MIN}min · Bias-Filter ${CONFIG.REQUIRE_BIAS_ALIGN ? 'an' : 'aus'} · Lot ${LOT_SIZE}`,
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
      const totalPnlPrice = perf.trades.reduce((a, t) => a + t.pnl, 0);
      const { pips, money } = toPipsAndMoney(key, totalPnlPrice);
      let cum = 0;
      const equity = perf.trades.map(t => {
        cum += toPipsAndMoney(key, t.pnl).money;
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
          const pm = toPipsAndMoney(key, t.pnl);
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
                  await sendTelegram(buildSwingSignalMsg(
                    sw.signal, assetLabel, sw.cur, sw.sl, sw.tp1, sw.tp2, sw.tp3, sw.rr, sw.rsi, sw.trend
                  ));
                  const swTrade = {
                    symbol: swingKey, signal: sw.signal, entry: sw.cur,
                    sl: sw.sl, tp1: sw.tp1, tp2: sw.tp2, tp3: sw.tp3, rr: sw.rr,
                    type: 'swing', timeoutMin: CONFIG.SWING_TIMEOUT_MIN, openedAt: Date.now(),
                  };
                  openTrades.push(swTrade);
                  swTrade.positionId = await broker.openTrade({ sessionKey, signal: sw.signal, entry: sw.cur, sl: sw.sl, tp: sw.tp3, type: 'swing', tag: swingKey });
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
          if (t >= T.RANGE_END && !sd.openingRange.sent && sd.openingRange.high !== null) {
            sd.openingRange.sent = true;
            await sendTelegram(buildOpeningRangeMsg(assetLabel, sd.openingRange.high, sd.openingRange.low));
            console.log(`🟣 Opening Range ${assetLabel}`);
          }

          // 3. Opening Range Breakout — nur einmal, nur wenn kein offener Trade
          if (sd.openingRange.sent && !sd.openingRange.breakoutSent && !hasOpenTrade(normSym)) {
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
              await sendTelegram(buildOpeningRangeSignalMsg(bo, assetLabel, close, sl, tp1, tp2, tp3, rr, sd.lastBias, trend15m));
              const orTrade = { symbol: normSym, signal: bo, entry: parseFloat(close.toFixed(2)), sl, tp1, tp2, tp3, rr, type: 'opening_range', openedAt: Date.now() };
              openTrades.push(orTrade);
              orTrade.positionId = await broker.openTrade({ sessionKey, signal: bo, entry: parseFloat(close.toFixed(2)), sl, tp: tp3, type: 'opening_range', tag: normSym });
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
              await sendTelegram(buildSignalMsg(result.signal, assetLabel, result.cur, result.sl, result.tp1, result.tp2, result.tp3, result.rr, result.rsi, result.macd, bias, trend15m, result.liqTarget, result.sweptLiquidity, result.grade, result.score, result.factors));
              const scTrade = { symbol: normSym, signal: result.signal, entry: result.cur, sl: result.sl, tp1: result.tp1, tp2: result.tp2, tp3: result.tp3, rr: result.rr, type: '4confirm', grade: result.grade, openedAt: Date.now() };
              openTrades.push(scTrade);
              scTrade.positionId = await broker.openTrade({ sessionKey, signal: result.signal, entry: result.cur, sl: result.sl, tp: result.tp3, type: 'scalp', tag: normSym });
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
  console.log(`📊 Config: SL ${CONFIG.SL_MULT}×ATR · TP1/2/3 = ${CONFIG.TP1_MULT}/${CONFIG.TP2_MULT}/${CONFIG.TP3_MULT}×ATR · Lot ${LOT_SIZE} · Swing EMA${CONFIG.SWING_EMA_SLOW}`);
  if (!TOKEN) console.warn('⚠️  BOT_TOKEN nicht gesetzt!');
});

// State periodisch sichern (alle 30s) + sauber beim Herunterfahren (Railway-Redeploy)
setInterval(saveState, 30000);
function gracefulExit() { try { saveState(); } catch (_) {} process.exit(0); }
process.on('SIGTERM', gracefulExit);
process.on('SIGINT', gracefulExit);
