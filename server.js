// ═══════════════════════════════════════════════════════════════════════════
//  APEX SIGNAL BOT v3 — TradingView Webhook → Telegram
//  Strategien: 4-Confirm Scalp · Daily Bias · NYC Opening Range · Multi-TF
//  Auto Win/Loss Tracking · Performance Report · Streak Tracker
// ═══════════════════════════════════════════════════════════════════════════
const https = require('https');
const http = require('http');

const TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID || "-5280319758";

// ─── KONFIGURATION ───────────────────────────────────────────────────────────
const CONFIG = {
  // ── SL/TP (× ATR) — verbessert: SL etwas enger, TP-Stufen sauber gestaffelt ──
  SL_MULT: 1.3,        // Stop Loss = 1.3 × ATR (vorher 1.5 — etwas enger für besseres R:R)
  TP1_MULT: 1.3,       // TP1 = 1.3 × ATR → R:R 1:1 bis TP1 (mind. so weit wie SL)
  TP2_MULT: 2.6,       // TP2 = 2.6 × ATR
  TP3_MULT: 4.0,       // TP3 = 4.0 × ATR (Runner)
  BREAKEVEN_AFTER_TP2: true, // Nach TP2: SL auf Entry (Break-Even)

  MAX_CANDLES: 300,
  TRADE_TIMEOUT_MIN: 240, // 4h
  RSI_BUY: [45, 65],
  RSI_SELL: [35, 55],

  // ── Qualitäts-Filter ──
  COOLDOWN_MIN: 15,
  MIN_ATR_PERCENT: 0.04,
  REQUIRE_BIAS_ALIGN: true,

  // ── Asia-Session-Filter (02:00–09:00 Berlin) — strenger, da dort viele Losses ──
  ASIA_START_MIN: 2 * 60,   // 02:00
  ASIA_END_MIN: 9 * 60,     // 09:00
  ASIA_MIN_ATR_PERCENT: 0.07, // höhere Mindest-Bewegung in Asia (fast 2× normal)
  ASIA_RSI_BUY: [50, 62],   // engeres RSI-Fenster in Asia (nur klarere Signale)
  ASIA_RSI_SELL: [38, 50],

  // ── Abend-Filter (ab 19:00 Berlin) — späte US-Session wird oft choppy, viele Losses ──
  EVENING_START_MIN: 19 * 60, // 19:00
  EVENING_END_MIN: 23 * 60,   // 23:00 (danach greift eh die ruhige Nacht)
  EVENING_MIN_ATR_PERCENT: 0.08, // nur noch starke Bewegungen abends
  EVENING_RSI_BUY: [52, 62],  // sehr enges RSI-Fenster abends
  EVENING_RSI_SELL: [38, 48],

  // ── Swing (1H) ──
  SWING_SL_MULT: 2,
  SWING_TP1_MULT: 2.0,
  SWING_TP2_MULT: 4.0,
  SWING_TP3_MULT: 6.0,
  SWING_TIMEOUT_MIN: 1440,
  SWING_EMA_FAST: 50,
  SWING_EMA_SLOW: 200,
  SWING_PULLBACK_EMA: 20,
};

// ── Symbol-spezifische Filter-Überschreibungen ──
// NASDAQ lief schlecht (43% Win-Rate, -52 Pips) → deutlich strenger filtern.
// Gold läuft gut → moderate Multi-Timeframe-Checks.
const SYMBOL_FILTERS = {
  'NDX': {
    minAtrPercent: 0.10,     // viel höhere Mindest-Bewegung (NASDAQ ist volatil — nur starke Moves)
    rsiBuy: [50, 62],        // engeres RSI-Fenster → nur klarere Momentum-Signale
    rsiSell: [38, 50],
    cooldownMin: 30,         // längere Pause zwischen Trades (weniger Overtrading)
    requireBiasAlign: true,  // strikt nur in Bias-Richtung
    require15mAlign: true,   // nur wenn 15M-Trend übereinstimmt
    require4hAlign: true,    // 4H-Trend muss übereinstimmen (Multi-TF Bias)
    require5mAlign: true,    // 5M-Entry-Momentum muss passen
    requireBOS: false,       // Break of Structure optional (kann zu streng sein)
    requireLiquidity: true,  // nur traden wenn Liquidität in Trade-Richtung liegt
  },
  'XAUUSD': {
    minAtrPercent: CONFIG.MIN_ATR_PERCENT,
    rsiBuy: CONFIG.RSI_BUY,
    rsiSell: CONFIG.RSI_SELL,
    cooldownMin: CONFIG.COOLDOWN_MIN,
    requireBiasAlign: CONFIG.REQUIRE_BIAS_ALIGN,
    require15mAlign: false,
    require4hAlign: true,    // 4H-Trend muss übereinstimmen (Multi-TF Bias)
    require5mAlign: true,    // 5M-Entry-Momentum muss passen
    requireBOS: false,       // Break of Structure optional
    requireLiquidity: true,  // nur traden wenn Liquidität in Trade-Richtung liegt
  },
};
function getFilters(sessionKey) {
  return SYMBOL_FILTERS[sessionKey] || SYMBOL_FILTERS['XAUUSD'];
}

// ── Pip- & Geldwert-Definitionen pro Symbol ──
// Gold: 1 Pip = 0.1 Preis-Einheiten. NASDAQ: 1 Pip = 1 Punkt.
// Geldwert pro Pip bei 0.01 Lot (Standard-Demo-Kontraktgrößen, Näherung in USD).
const PIP_INFO = {
  'XAUUSD': { pipSize: 0.1, moneyPerPipPerLot: 0.10 },  // 0.01 Lot Gold: $1 pro $1-Bewegung → $0.10/Pip
  'NDX':    { pipSize: 1.0, moneyPerPipPerLot: 0.20 },  // 0.01 Lot NAS100 ≈ $0.20/Punkt (Näherung)
};
const LOT_SIZE = 0.01;

// Wandelt eine Preis-Differenz in Pips + Geldwert um
function toPipsAndMoney(sessionKey, priceDiff) {
  const info = PIP_INFO[sessionKey] || { pipSize: 1, moneyPerPipPerLot: 1 };
  const pips = priceDiff / info.pipSize;
  const money = pips * info.moneyPerPipPerLot * (LOT_SIZE / 0.01);
  return { pips, money };
}

// Formatiert PnL als "+12.5 Pips (+$1.25)" — sessionKey bestimmt Pip-Größe
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
// Generische Aggregation: fasst N 1M-Kerzen zu einer größeren Kerze zusammen
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
// Trend auf beliebigem Timeframe (size = Anzahl 1M-Kerzen pro Kerze)
function getTrendOnTF(closes, highs, lows, size) {
  const tf = aggregateTF(closes, highs, lows, size);
  if (tf.closes.length < 26) return null;
  const e12 = ema(tf.closes, 12), e26 = ema(tf.closes, 26);
  if (e12 === null || e26 === null) return null;
  return e12 > e26 ? 'BUY' : 'SELL';
}
// 5M-Entry-Bestätigung: kurzfristiges Momentum über EMA9 vs EMA21
function get5MTrend(closes, highs, lows) {
  const tf = aggregateTF(closes, highs, lows, 5);
  if (tf.closes.length < 21) return null;
  const e9 = ema(tf.closes, 9), e21 = ema(tf.closes, 21);
  if (e9 === null || e21 === null) return null;
  return e9 > e21 ? 'BUY' : 'SELL';
}

// ─── LIQUIDITÄT (1H Swing-Highs/Lows als Annäherung) ──────────────────────────
// Findet markante Hochs/Tiefs auf dem 1H-Chart. Liquidität liegt typischerweise
// über letzten Hochs (Short-Stops) und unter letzten Tiefs (Long-Stops).
function findLiquidity(closes, highs, lows) {
  const h1 = aggregateTF(closes, highs, lows, 60); // 60 × 1M = 1H
  if (h1.closes.length < 10) return null;
  const cur = closes[closes.length - 1];
  const lookback = Math.min(20, h1.highs.length); // letzte ~20 Stunden
  const recentHighs = h1.highs.slice(-lookback);
  const recentLows = h1.lows.slice(-lookback);

  // Nächstes Hoch ÜBER dem aktuellen Preis = Liquidität oben (Long-Ziel)
  const liqAbove = recentHighs.filter(h => h > cur).sort((a, b) => a - b)[0] || null;
  // Nächstes Tief UNTER dem aktuellen Preis = Liquidität unten (Short-Ziel)
  const liqBelow = recentLows.filter(l => l < cur).sort((a, b) => b - a)[0] || null;

  return { liqAbove, liqBelow, cur };
}

// ─── BREAK OF STRUCTURE (vereinfacht) ─────────────────────────────────────────
// Prüft ob der Preis das letzte markante Hoch (bullish BOS) oder Tief (bearish BOS)
// auf dem 15M-Chart gebrochen hat. Anerkanntes Konzept, hier regelbasiert.
function breakOfStructure(closes, highs, lows) {
  const tf = aggregateTF(closes, highs, lows, 15);
  if (tf.closes.length < 8) return null;
  const cur = tf.closes[tf.closes.length - 1];
  // Letzte 6 Kerzen OHNE die aktuelle betrachten
  const prevHighs = tf.highs.slice(-7, -1);
  const prevLows = tf.lows.slice(-7, -1);
  const lastSwingHigh = Math.max(...prevHighs);
  const lastSwingLow = Math.min(...prevLows);
  if (cur > lastSwingHigh) return 'BUY';  // bullish Break of Structure
  if (cur < lastSwingLow) return 'SELL';  // bearish Break of Structure
  return null; // keine Struktur gebrochen
}

// ─── STRATEGIE: 4-Confirm Conservative Scalp ───────────────────────────────────
function runStrategy(closes, highs, lows, sessionKey) {
  if (closes.length < 70) return null;
  const cur = closes[closes.length - 1];
  const prev = closes.slice(0, -1);

  const filt = getFilters(sessionKey);

  // Ist gerade Asia-Session? Dann strengere Filter anwenden
  const tNow = berlinMinutesOfDay();
  const isAsia = tNow >= CONFIG.ASIA_START_MIN && tNow < CONFIG.ASIA_END_MIN;
  // Ist gerade Abend (späte US-Session)? Dann ebenfalls strenger
  const isEvening = tNow >= CONFIG.EVENING_START_MIN && tNow < CONFIG.EVENING_END_MIN;

  const e12n = ema(closes, 12), e26n = ema(closes, 26);
  const e12p = ema(prev, 12), e26p = ema(prev, 26);
  if ([e12n, e26n, e12p, e26p].some(v => v === null)) return null;

  const crossUp = e12p <= e26p && e12n > e26n;
  const crossDown = e12p >= e26p && e12n < e26n;

  const rv = rsiCalc(closes);
  if (rv === null) return null;
  // RSI-Fenster: Asia/Abend am strengsten, sonst symbol-spezifisch
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

  // ATR-Filter: Asia/Abend am strengsten, sonst symbol-spezifisch
  const atrPercent = (atrV / cur) * 100;
  let minAtr = filt.minAtrPercent;
  if (isAsia) minAtr = Math.max(CONFIG.ASIA_MIN_ATR_PERCENT, filt.minAtrPercent);
  else if (isEvening) minAtr = Math.max(CONFIG.EVENING_MIN_ATR_PERCENT, filt.minAtrPercent);
  if (atrPercent < minAtr) return null;

  const buyS = crossUp && rsiBuy && mBull && cur > s50;
  const sellS = crossDown && rsiSell && mBear && cur < s50;
  if (!buyS && !sellS) return null;

  const signal = buyS ? 'BUY' : 'SELL';

  // ── Multi-Timeframe-Filter (aus dem Profi-Konzept: Bias → Liquidität → Entry) ──

  // 15M-Trend (Entry-Ebene, optional)
  if (filt.require15mAlign) {
    const t15 = get15MTrend(closes, highs, lows);
    if (t15 && t15 !== signal) return null;
  }
  // 4H-Trend (Bias-Ebene): großer Trend muss zur Signal-Richtung passen
  if (filt.require4hAlign) {
    const t4h = getTrendOnTF(closes, highs, lows, 240); // 240 × 1M = 4H
    if (t4h && t4h !== signal) return null;
  }
  // 5M-Momentum (Entry-Ebene): kurzfristiges Momentum muss passen
  if (filt.require5mAlign) {
    const t5 = get5MTrend(closes, highs, lows);
    if (t5 && t5 !== signal) return null;
  }
  // Break of Structure (15M): nur traden wenn Struktur in Signal-Richtung gebrochen
  if (filt.requireBOS) {
    const bos = breakOfStructure(closes, highs, lows);
    if (bos && bos !== signal) return null;
  }
  // Liquidität (1H Swing-Punkte): nur traden wenn "Ziel-Liquidität" in Trade-Richtung liegt
  let liqInfo = null;
  if (filt.requireLiquidity) {
    const liq = findLiquidity(closes, highs, lows);
    if (liq) {
      liqInfo = liq;
      // BUY braucht Liquidität oben (liqAbove), SELL braucht Liquidität unten (liqBelow)
      if (signal === 'BUY' && liq.liqAbove === null) return null;
      if (signal === 'SELL' && liq.liqBelow === null) return null;
    }
  }

  const dir = buyS ? 1 : -1;
  const sl = parseFloat((cur - dir * atrV * CONFIG.SL_MULT).toFixed(2));
  const tp1 = parseFloat((cur + dir * atrV * CONFIG.TP1_MULT).toFixed(2));
  const tp2 = parseFloat((cur + dir * atrV * CONFIG.TP2_MULT).toFixed(2));
  const tp3 = parseFloat((cur + dir * atrV * CONFIG.TP3_MULT).toFixed(2));
  const rr = (CONFIG.TP1_MULT / CONFIG.SL_MULT).toFixed(2);

  // Liquiditäts-Ziel für die Nachricht (wohin der Markt "will")
  const liqTarget = liqInfo
    ? (signal === 'BUY' ? liqInfo.liqAbove : liqInfo.liqBelow)
    : null;

  return {
    signal,
    cur: parseFloat(cur.toFixed(2)),
    sl, tp1, tp2, tp3, rr,
    rsi: rv.toFixed(1),
    macd: mn.toFixed(3),
    liqTarget: liqTarget ? parseFloat(liqTarget.toFixed(2)) : null,
  };
}

// ─── SWING-STRATEGIE: Trend-Following mit Pullback (1H) ────────────────────────
// Anders als der Scalp: wartet auf etablierten Trend + günstigen Pullback-Einstieg
function runSwingStrategy(closes, highs, lows) {
  const need = CONFIG.SWING_EMA_SLOW + 5;
  if (closes.length < need) return null; // braucht genug Historie für EMA200

  const cur = closes[closes.length - 1];
  const emaFast = ema(closes, CONFIG.SWING_EMA_FAST);   // EMA 50
  const emaSlow = ema(closes, CONFIG.SWING_EMA_SLOW);   // EMA 200
  const emaPull = ema(closes, CONFIG.SWING_PULLBACK_EMA); // EMA 20
  if ([emaFast, emaSlow, emaPull].some(v => v === null)) return null;

  const rv = rsiCalc(closes);
  if (rv === null) return null;

  const atrV = atrCalc(closes, highs, lows) || cur * 0.005;

  // Trend-Definition: EMA50 vs EMA200
  const uptrend = emaFast > emaSlow;
  const downtrend = emaFast < emaSlow;

  // Pullback: Preis ist nah an der EMA20 zurückgekommen (innerhalb 0.5×ATR)
  const nearPullback = Math.abs(cur - emaPull) <= atrV * 0.5;

  // Einstieg: Trend + Pullback + RSI bestätigt Momentum-Richtung
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
// Minuten seit Mitternacht (Berlin) — für saubere Zeitfenster-Checks
function berlinMinutesOfDay() { const { hour, min } = berlinParts(); return hour * 60 + min; }

// Zeitfenster (in Minuten seit Mitternacht)
const T = {
  MORNING: 8 * 60,          // 08:00 — Guten Morgen / Bot aktiv
  ASIA_START: 2 * 60,       // 02:00
  ASIA_END: 9 * 60,         // 09:00
  LONDON_END: 15 * 60 + 30, // 15:30
  NYC_OPEN: 15 * 60 + 30,   // 15:30
  RANGE_END: 15 * 60 + 45,  // 15:45
  NYC_CLOSE: 22 * 60,       // 22:00
  REPORT: 22 * 60,          // 22:00
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

// Globaler Tages-Tracker für Nachrichten die nur EINMAL pro Tag kommen (nicht pro Symbol)
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
    const perf = sd.performance; // Performance über Nacht behalten? Nein — täglich frisch.
    Object.assign(sd, freshSession());
    sd.date = today;
    console.log(`🔄 Day reset für ${today}`);
  }
}

function updateSessions(sd, high, low) {
  const t = berlinMinutesOfDay();

  // Asia: 02:00–09:00
  if (t >= T.ASIA_START && t < T.ASIA_END) {
    if (sd.asiaHigh === null || high > sd.asiaHigh) sd.asiaHigh = high;
    if (sd.asiaLow === null || low < sd.asiaLow) sd.asiaLow = low;
  }

  // London: 09:00–15:30
  if (t >= T.ASIA_END && t < T.LONDON_END) {
    if (sd.asiaHigh !== null && high > sd.asiaHigh) sd.londonBrokeHigh = true;
    if (sd.asiaLow !== null && low < sd.asiaLow) sd.londonBrokeLow = true;
  }

  // NYC Opening Range: 15:30–15:45
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
  if (berlinMinutesOfDay() < T.RANGE_END) return null; // Range noch nicht abgeschlossen
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
// Pro Symbol max. 1 offener Trade gleichzeitig → kein Durcheinander
const openTrades = []; // { symbol, signal, entry, sl, tp, rr, type, openedAt(ms) }

// Cooldown: Zeitpunkt des letzten Trades pro Symbol (verhindert Doppel-Feuern)
const lastTradeTime = {}; // normSym -> ms

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

    // Hilfsfunktion: wurde ein Level erreicht?
    const reached = (level) => isBuy ? high >= level : low <= level;

    // ── TP1 ── → Trade zählt als WIN (nur einmal werten)
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

    // ── TP2 ── → SL auf Break-Even
    if (trade.tp1Hit && !trade.tp2Hit && reached(trade.tp2)) {
      trade.tp2Hit = true;
      const pnl = Math.abs(trade.tp2 - trade.entry);
      if (CONFIG.BREAKEVEN_AFTER_TP2) trade.sl = trade.entry; // Break-Even
      await sendTelegram(`🎯 *TP2 HIT — ${assetLabel}* ✅

${dirEmoji} ${trade.signal} · ${typeLabel}
🎯 TP2 erreicht: \`${trade.tp2.toFixed(2)}\`
💵 +\`${fmtPnl(sessionKey, Math.abs(trade.tp2 - trade.entry))}\`
${CONFIG.BREAKEVEN_AFTER_TP2 ? '🛡 *SL jetzt auf Break-Even* — Rest läuft risikofrei!' : ''}
🔜 Letztes Ziel: \`${trade.tp3.toFixed(2)}\`
⚡ _Apex Signal Bot_`);
      console.log(`🎯 TP2 HIT: ${trade.signal} ${assetLabel} → Break-Even`);
    }

    // ── TP3 ── → Trade komplett geschlossen (voll durchgelaufen)
    if (trade.tp2Hit && reached(trade.tp3)) {
      const pnl = Math.abs(trade.tp3 - trade.entry);
      await sendTelegram(`🎯 *TP3 HIT — ${assetLabel}* 🏆

${dirEmoji} ${trade.signal} · ${typeLabel}
🎯 TP3 erreicht: \`${trade.tp3.toFixed(2)}\`
💵 +\`${fmtPnl(sessionKey, Math.abs(trade.tp3 - trade.entry))}\` — *voll durchgelaufen!* 🚀
✅ Trade abgeschlossen.
⚡ _Apex Signal Bot_`);
      console.log(`🏆 TP3 HIT: ${trade.signal} ${assetLabel} — geschlossen`);
      continue; // Trade entfernt (nicht in remaining)
    }

    // ── SL ── (kann Break-Even sein nach TP2)
    const slHit = isBuy ? low <= trade.sl : high >= trade.sl;
    if (slHit) {
      const atBreakeven = trade.tp1Hit && trade.sl === trade.entry;
      if (atBreakeven) {
        // Break-Even Stop nach TP1/TP2 — kein zusätzlicher Verlust, WIN steht schon
        await sendTelegram(`🛡 *BREAK-EVEN STOP — ${assetLabel}*

${dirEmoji} ${trade.signal} · ${typeLabel}
Position bei Entry \`${trade.entry.toFixed(2)}\` geschlossen.
✅ Gewinne aus TP1${trade.tp2Hit ? '/TP2' : ''} sind gesichert — kein Verlust.
⚡ _Apex Signal Bot_`);
        console.log(`🛡 Break-Even Stop: ${trade.signal} ${assetLabel}`);
      } else {
        // Echter Verlust — nur werten wenn TP1 noch NICHT getroffen war
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
      continue; // Trade entfernt
    }

    // ── Timeout ──
    const timeoutMin = trade.timeoutMin || CONFIG.TRADE_TIMEOUT_MIN;
    if ((now - trade.openedAt) > timeoutMin * 60 * 1000) {
      // Wenn TP1 schon getroffen: Trade war Win, einfach schließen. Sonst neutral.
      if (!trade.tp1Hit) {
        await sendTelegram(`⏱ *TIMEOUT — ${assetLabel}*

${dirEmoji} ${trade.signal} · ${typeLabel}
Trade nach Zeitlimit geschlossen (kein TP/SL erreicht).
💰 Entry war \`${trade.entry.toFixed(2)}\`
⚡ _Apex Signal Bot_`);
        console.log(`⏱ TIMEOUT: ${trade.signal} ${assetLabel}`);
      }
      continue; // Trade entfernt
    }

    // Trade bleibt offen
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

function buildSignalMsg(signal, asset, entry, sl, tp1, tp2, tp3, rr, rsi, macd, bias, trend15m, liqTarget) {
  const emoji = signal === 'BUY' ? '🟢' : '🔴';
  const dir = signal === 'BUY' ? '📈' : '📉';
  const liqLine = liqTarget ? `\n💧 *Liquiditäts-Ziel:* \`${liqTarget.toFixed(2)}\`` : '';
  return `${emoji} *${signal} NOW* — ${asset} ${dir}${biasTag(bias, signal)}

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
• Multi-Timeframe bestätigt ✅

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
// Separate Speicher für 1H Swing-Kerzen (damit sie sich nicht mit 1M Scalp mischen)
const swingStore = {
  'XAUUSD': { closes: [], highs: [], lows: [], lastSignal: null },
  'NDX':    { closes: [], highs: [], lows: [], lastSignal: null },
};
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
// Eindeutiger Key für openTrades/lastSignal. Swing bekommt eigenen Key (z.B. XAUUSD_SWING)
function normalizeSymbol(symbol) {
  const base = getSessionKey(symbol) || symbol.toUpperCase();
  return isSwing(symbol) ? `${base}_SWING` : base;
}

// ─── SERVER ────────────────────────────────────────────────────────────────────
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="de"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Apex Signal Bot — Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#06090F;color:#B8CDE0;font-family:'Segoe UI',system-ui,sans-serif;padding:16px;max-width:900px;margin:0 auto}
.head{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;flex-wrap:wrap;gap:8px}
.title{font-size:22px;font-weight:800;letter-spacing:.12em;color:#E0F2FF}
.sub{font-size:10px;color:#1A5A7A;letter-spacing:.25em}
.live{background:#003322;color:#00FF88;border:1px solid #00FF8855;padding:6px 14px;border-radius:20px;font-size:12px;font-weight:600}
.tabs{display:flex;gap:8px;margin-bottom:16px}
.tab{flex:1;padding:10px;background:#0B1018;border:1px solid #16202E;border-radius:8px;color:#3A6A8A;cursor:pointer;text-align:center;font-weight:600;font-size:14px}
.tab.active{background:#0A1828;color:#FFD060;border-color:#FFD06055}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:18px}
.card{background:#0B1018;border:1px solid #16202E;border-radius:10px;padding:14px}
.label{font-size:9px;color:#3A6A8A;letter-spacing:.15em;margin-bottom:5px;text-transform:uppercase}
.value{font-size:24px;font-weight:700}
.green{color:#00FF88}.red{color:#FF4455}.blue{color:#38BDF8}.white{color:#E0F2FF}.gold{color:#FFD060}
.bar{height:8px;background:#0A1828;border-radius:4px;overflow:hidden;display:flex;margin-bottom:18px}
.bar>div{transition:width .8s}
table{width:100%;border-collapse:collapse;background:#0B1018;border-radius:10px;overflow:hidden}
th{background:#0E1622;color:#3A6A8A;font-size:10px;letter-spacing:.1em;text-transform:uppercase;padding:9px;text-align:left}
td{padding:9px;border-top:1px solid #16202E;font-size:13px}
.buy{color:#00FF88;font-weight:700}.sell{color:#FF4455;font-weight:700}
.muted{color:#3A6A8A;font-size:12px}.empty{text-align:center;padding:24px;color:#3A6A8A}
.sect{font-size:11px;color:#3A6A8A;letter-spacing:.2em;text-transform:uppercase;margin:20px 0 10px}
.open{background:#0A1828;border:1px solid #FFD06033;border-radius:8px;padding:10px 12px;margin-bottom:6px;font-size:13px;display:flex;justify-content:space-between;align-items:center}
.hidden{display:none}
</style></head><body>
<div class="head">
  <div><div class="title">⚡ APEX SIGNAL BOT</div><div class="sub">LIVE DASHBOARD</div></div>
  <div class="live" id="status">● LIVE</div>
</div>
<div class="tabs">
  <div class="tab active" id="tab-gold" onclick="sw('gold')">🥇 XAU/USD</div>
  <div class="tab" id="tab-ndx" onclick="sw('ndx')">📊 NASDAQ</div>
</div>
<div class="grid" id="stats"></div>
<div class="bar" id="wbar"></div>
<div class="sect">Offene Trades</div>
<div id="opentrades"></div>
<div class="sect">Letzte Trades (Pips · Geld bei 0.01 Lot)</div>
<table><thead><tr><th>Zeit</th><th>Richtung</th><th>Ergebnis</th><th>Pips</th><th>Geld</th></tr></thead>
<tbody id="history"><tr><td colspan="5" class="empty">Lädt...</td></tr></tbody></table>
<div style="text-align:center;margin-top:16px;font-size:10px;color:#1A4060">Aktualisiert alle 5s · Apex Signal Bot</div>
<script>
let cur='gold', data=null;
function sw(t){cur=t;document.getElementById('tab-gold').className='tab'+(t==='gold'?' active':'');document.getElementById('tab-ndx').className='tab'+(t==='ndx'?' active':'');render();}
function render(){
  if(!data)return;
  const d=data[cur];
  document.getElementById('stats').innerHTML=[
    ['Win-Rate',d.winRate+'%',parseFloat(d.winRate)>=50?'green':'red'],
    ['Wins',d.wins,'green'],['Losses',d.losses,'red'],
    ['Total Pips',(d.totalPips>0?'+':'')+d.totalPips,d.totalPips>=0?'green':'red'],
    ['Total Geld',(d.totalMoney>0?'+':'')+'$'+d.totalMoney,d.totalMoney>=0?'green':'red'],
    ['Serie',d.streak+'× '+(d.streakType||'-'),d.streakType==='WIN'?'green':d.streakType==='LOSS'?'red':'white'],
    ['Kerzen',d.candles,'blue'],['Swing-Kerzen',d.swingCandles+(d.swingCandles>=205?' ✅':''),'blue'],
    ['Bias',d.bias,'gold'],
  ].map(([l,v,c])=>'<div class="card"><div class="label">'+l+'</div><div class="value '+c+'">'+v+'</div></div>').join('');
  const tot=d.wins+d.losses;
  const wp=tot>0?d.wins/tot*100:0;
  document.getElementById('wbar').innerHTML='<div style="width:'+wp+'%;background:linear-gradient(90deg,#00AA55,#00FF88)"></div><div style="flex:1;background:#3A1A1A"></div>';
  const ot=data.openTrades.filter(t=>cur==='gold'?t.symbol.includes('XAU'):t.symbol.includes('NASDAQ'));
  document.getElementById('opentrades').innerHTML=ot.length?ot.map(t=>'<div class="open"><span class="'+(t.signal==='BUY'?'buy':'sell')+'">'+t.signal+' · '+t.type+'</span><span class="muted">Entry '+t.entry+(t.tp1Hit?' · TP1✅':'')+(t.tp2Hit?' TP2🛡':'')+'</span></div>').join(''):'<div class="empty">Keine offenen Trades</div>';
  document.getElementById('history').innerHTML=d.trades.length?d.trades.map(t=>'<tr><td class="muted">'+t.time+'</td><td class="'+(t.signal==='BUY'?'buy':'sell')+'">'+t.signal+'</td><td>'+(t.result==='WIN'?'✅ WIN':'❌ LOSS')+'</td><td class="'+(t.pips>=0?'green':'red')+'">'+(t.pips>0?'+':'')+t.pips+'</td><td class="muted">'+(t.money>0?'+':'')+'$'+t.money+'</td></tr>').join(''):'<tr><td colspan="5" class="empty">Noch keine Trades</td></tr>';
}
async function refresh(){
  try{const r=await fetch('/data');data=await r.json();document.getElementById('status').textContent='● LIVE · '+data.time;render();}
  catch(e){document.getElementById('status').textContent='● offline';}
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
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end([
      '⚡ Apex Signal Bot v3 läuft ✅',
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
      '── Swing (1H) — braucht 205 Kerzen für EMA200 ──',
      `XAU/USD Swing-Kerzen: ${swingStore['XAUUSD'].closes.length} ${swingStore['XAUUSD'].closes.length >= 205 ? '✅' : '(sammelt...)'}`,
      `NDX Swing-Kerzen:     ${swingStore['NDX'].closes.length} ${swingStore['NDX'].closes.length >= 205 ? '✅' : '(sammelt...)'}`,
      '',
      `Scalp: 5M · Cooldown ${CONFIG.COOLDOWN_MIN}min · Bias-Filter ${CONFIG.REQUIRE_BIAS_ALIGN ? 'an' : 'aus'}`,
      `Token gesetzt: ${TOKEN ? 'ja' : 'NEIN ⚠️'}`,
      '',
      '👉 Schickes Dashboard: /dashboard',
    ].join('\n'));
  }

  // Dashboard JSON-Daten
  if (req.method === 'GET' && req.url === '/data') {
    const build = (key) => {
      const sd = sessionData[key];
      const perf = sd.performance;
      const total = perf.wins + perf.losses;
      const totalPnlPrice = perf.trades.reduce((a, t) => a + t.pnl, 0);
      const { pips, money } = toPipsAndMoney(key, totalPnlPrice);
      return {
        candles: store[key].closes.length,
        swingCandles: swingStore[key].closes.length,
        wins: perf.wins, losses: perf.losses,
        winRate: total > 0 ? (perf.wins / total * 100).toFixed(1) : '0',
        streak: perf.streak, streakType: perf.streakType,
        bestStreak: perf.bestStreak, worstStreak: perf.worstStreak,
        totalPips: pips.toFixed(1), totalMoney: money.toFixed(2),
        bias: sd.lastBias || '-',
        asiaHigh: sd.asiaHigh, asiaLow: sd.asiaLow,
        trades: perf.trades.slice(-15).reverse().map(t => {
          const pm = toPipsAndMoney(key, t.pnl);
          return { signal: t.signal, result: t.result, pips: pm.pips.toFixed(1), money: pm.money.toFixed(2), time: t.time };
        }),
      };
    };
    const payload = {
      time: getBerlinTime(), date: getBerlinDate(),
      openTrades: openTrades.map(t => ({ symbol: getAssetLabel(t.symbol), signal: t.signal, type: t.type, entry: t.entry, tp1Hit: !!t.tp1Hit, tp2Hit: !!t.tp2Hit })),
      gold: build('XAUUSD'), ndx: build('NDX'),
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

        // Morgennachricht (08:00) — nur EINMAL pro Tag, egal welches Symbol triggert
        resetDailyFlagsIfNeeded();
        if (berlinMinutesOfDay() >= T.MORNING && !dailyFlags.morningSent) {
          dailyFlags.morningSent = true;
          await sendTelegram(buildMorningMsg());
          console.log('☀️ Morgennachricht gesendet');
        }

        // 0. Offene Trades prüfen (TP/SL/Timeout)
        await checkOpenTrades(normSym, high, low);

        // ─── SWING TRADES (1H) — Trend-Following + Pullback, eigenes Setup ───
        if (isSwing(symbol)) {
          if (!hasOpenTrade(normSym) && !inCooldown(normSym)) {
            const sw = runSwingStrategy(st.closes, st.highs, st.lows);
            if (sw) {
              const signalKey = `${sw.signal}-${Math.round(sw.cur)}`;
              if (st.lastSignal !== signalKey) {
                st.lastSignal = signalKey;
                await sendTelegram(buildSwingSignalMsg(sw.signal, assetLabel, sw.cur, sw.sl, sw.tp1, sw.tp2, sw.tp3, sw.rr, sw.rsi, sw.trend));
                openTrades.push({ symbol: normSym, signal: sw.signal, entry: sw.cur, sl: sw.sl, tp1: sw.tp1, tp2: sw.tp2, tp3: sw.tp3, rr: sw.rr, type: 'swing', timeoutMin: CONFIG.SWING_TIMEOUT_MIN, openedAt: Date.now() });
                lastTradeTime[normSym] = Date.now();
                console.log(`🟠 Swing: ${sw.signal} ${assetLabel} (${sw.trend})`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ ok: true, signal: sw.signal, type: 'swing', entry: sw.cur }));
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
              openTrades.push({ symbol: normSym, signal: bo, entry: parseFloat(close.toFixed(2)), sl, tp1, tp2, tp3, rr, type: 'opening_range', openedAt: Date.now() });
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

        // 5. 4-Confirm Signal — nur wenn kein offener Trade UND kein Cooldown aktiv
        if (!hasOpenTrade(normSym) && !inCooldown(normSym)) {
          const result = runStrategy(st.closes, st.highs, st.lows, sessionKey);
          if (result) {
            const bias = sd?.lastBias || null;
            // Bias-Filter: nur Trades in Richtung des Daily Bias (symbol-spezifisch)
            const biasBlocks = getFilters(sessionKey).requireBiasAlign
              && bias && bias !== 'WATCH' && bias !== 'NEUTRAL'
              && bias !== result.signal;

            const signalKey = `${result.signal}-${Math.round(result.cur)}`;
            if (!biasBlocks && st.lastSignal !== signalKey) {
              st.lastSignal = signalKey;
              const trend15m = get15MTrend(st.closes, st.highs, st.lows);
              await sendTelegram(buildSignalMsg(result.signal, assetLabel, result.cur, result.sl, result.tp1, result.tp2, result.tp3, result.rr, result.rsi, result.macd, bias, trend15m, result.liqTarget));
              openTrades.push({ symbol: normSym, signal: result.signal, entry: result.cur, sl: result.sl, tp1: result.tp1, tp2: result.tp2, tp3: result.tp3, rr: result.rr, type: '4confirm', openedAt: Date.now() });
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
  console.log(`🚀 Apex Signal Bot v3 läuft auf Port ${PORT}`);
  console.log(`📊 Config: SL ${CONFIG.SL_MULT}×ATR · TP1/2/3 = ${CONFIG.TP1_MULT}/${CONFIG.TP2_MULT}/${CONFIG.TP3_MULT}×ATR · R:R bis TP1 = 1:${(CONFIG.TP1_MULT/CONFIG.SL_MULT).toFixed(2)}`);
  if (!TOKEN) console.warn('⚠️  BOT_TOKEN nicht gesetzt!');
});
