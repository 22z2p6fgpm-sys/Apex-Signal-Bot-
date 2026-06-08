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
  SL_MULT: 1.5,        // Stop Loss = 1.5 × ATR
  TP_MULT: 2.5,        // Take Profit = 2.5 × ATR
  MAX_CANDLES: 300,    // Wie viele Kerzen im Speicher
  TRADE_TIMEOUT_MIN: 240, // Trade nach 4h schließen wenn weder TP noch SL
  RSI_BUY: [45, 65],
  RSI_SELL: [35, 55],
  // Qualitäts-Filter (smarter statt nur strenger)
  COOLDOWN_MIN: 15,        // Nach einem Trade X Min Pause pro Symbol (kein Doppel-Feuern)
  MIN_ATR_PERCENT: 0.04,   // Mindest-Bewegung: ATR muss >= 0.04% vom Preis sein (kein toter Markt)
  REQUIRE_BIAS_ALIGN: true, // Scalp nur in Richtung des Daily Bias (wenn Bias gesetzt)
  // Swing Trades (1H Timeframe) — eigenes Trend-Following-Setup mit Pullback
  SWING_SL_MULT: 2,        // weiterer Stop Loss = 2 × ATR
  SWING_TP_MULT: 4,        // weiteres Take Profit = 4 × ATR
  SWING_TIMEOUT_MIN: 1440, // 24h Timeout
  SWING_EMA_FAST: 50,      // Trend-Definition: schnelle EMA
  SWING_EMA_SLOW: 200,     // Trend-Definition: langsame EMA
  SWING_PULLBACK_EMA: 20,  // Einstieg beim Pullback zur EMA20
};

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
  const out = { closes: [], highs: [], lows: [] };
  const size = 15;
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

// ─── STRATEGIE: 4-Confirm Conservative Scalp ───────────────────────────────────
function runStrategy(closes, highs, lows, slMult = CONFIG.SL_MULT, tpMult = CONFIG.TP_MULT) {
  if (closes.length < 70) return null;
  const cur = closes[closes.length - 1];
  const prev = closes.slice(0, -1);

  const e12n = ema(closes, 12), e26n = ema(closes, 26);
  const e12p = ema(prev, 12), e26p = ema(prev, 26);
  if ([e12n, e26n, e12p, e26p].some(v => v === null)) return null;

  const crossUp = e12p <= e26p && e12n > e26n;
  const crossDown = e12p >= e26p && e12n < e26n;

  const rv = rsiCalc(closes);
  if (rv === null) return null;
  const rsiBuy = rv >= CONFIG.RSI_BUY[0] && rv <= CONFIG.RSI_BUY[1];
  const rsiSell = rv >= CONFIG.RSI_SELL[0] && rv <= CONFIG.RSI_SELL[1];

  const mn = macdL(closes), mp = macdL(prev);
  if (mn === null || mp === null) return null;
  const mBull = mn > 0 && mn > mp;
  const mBear = mn < 0 && mn < mp;

  const s50 = sma(closes, 50);
  if (s50 === null) return null;

  const atrV = atrCalc(closes, highs, lows) || cur * 0.005;

  // Qualitäts-Filter: Markt muss sich genug bewegen (kein totes Seitwärts-Gezappel)
  const atrPercent = (atrV / cur) * 100;
  if (atrPercent < CONFIG.MIN_ATR_PERCENT) return null;

  const buyS = crossUp && rsiBuy && mBull && cur > s50;
  const sellS = crossDown && rsiSell && mBear && cur < s50;
  if (!buyS && !sellS) return null;

  const signal = buyS ? 'BUY' : 'SELL';
  const sl = buyS ? cur - atrV * slMult : cur + atrV * slMult;
  const tp = buyS ? cur + atrV * tpMult : cur - atrV * tpMult;
  const rr = (tpMult / slMult).toFixed(2);

  return {
    signal,
    cur: parseFloat(cur.toFixed(2)),
    sl: parseFloat(sl.toFixed(2)),
    tp: parseFloat(tp.toFixed(2)),
    rr,
    rsi: rv.toFixed(1),
    macd: mn.toFixed(3),
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
  const sl = buy ? cur - atrV * CONFIG.SWING_SL_MULT : cur + atrV * CONFIG.SWING_SL_MULT;
  const tp = buy ? cur + atrV * CONFIG.SWING_TP_MULT : cur - atrV * CONFIG.SWING_TP_MULT;
  const rr = (CONFIG.SWING_TP_MULT / CONFIG.SWING_SL_MULT).toFixed(2);

  return {
    signal,
    cur: parseFloat(cur.toFixed(2)),
    sl: parseFloat(sl.toFixed(2)),
    tp: parseFloat(tp.toFixed(2)),
    rr,
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
  return (Date.now() - last) < CONFIG.COOLDOWN_MIN * 60 * 1000;
}

async function checkOpenTrades(symbol, high, low) {
  const sessionKey = getSessionKey(symbol);
  const assetLabel = getAssetLabel(symbol);
  const sd = sessionKey ? sessionData[sessionKey] : null;
  const now = Date.now();
  const remaining = [];

  for (const trade of openTrades) {
    if (trade.symbol !== symbol) { remaining.push(trade); continue; }

    let result = null, exitPrice = null;
    if (trade.signal === 'BUY') {
      if (high >= trade.tp) { result = 'WIN'; exitPrice = trade.tp; }
      else if (low <= trade.sl) { result = 'LOSS'; exitPrice = trade.sl; }
    } else {
      if (low <= trade.tp) { result = 'WIN'; exitPrice = trade.tp; }
      else if (high >= trade.sl) { result = 'LOSS'; exitPrice = trade.sl; }
    }

    // Timeout (Swing-Trades haben längeren Timeout)
    const timeoutMin = trade.timeoutMin || CONFIG.TRADE_TIMEOUT_MIN;
    if (!result && (now - trade.openedAt) > timeoutMin * 60 * 1000) {
      result = 'TIMEOUT'; exitPrice = trade.entry;
    }

    if (!result) { remaining.push(trade); continue; }

    const pnl = result === 'TIMEOUT' ? 0
      : (trade.signal === 'BUY' ? exitPrice - trade.entry : trade.entry - exitPrice);

    if (sd && result !== 'TIMEOUT') recordTrade(sd, trade, result, pnl);

    const emoji = result === 'WIN' ? '✅' : result === 'LOSS' ? '❌' : '⏱';
    const total = sd ? sd.performance.wins + sd.performance.losses : 0;
    const winRate = total > 0 ? ((sd.performance.wins / total) * 100).toFixed(1) : '0';

    const typeLabel = trade.type === 'opening_range' ? 'Opening Range' : trade.type === 'swing' ? '🟠 Swing' : '4-Confirm';
    const msg = `${emoji} *TRADE ${result}* — ${assetLabel}

${trade.signal === 'BUY' ? '📈' : '📉'} ${trade.signal} · ${typeLabel}
💰 Entry: \`${trade.entry.toFixed(2)}\`
${result === 'WIN' ? `🎯 TP: \`${trade.tp.toFixed(2)}\`` : result === 'LOSS' ? `🛑 SL: \`${trade.sl.toFixed(2)}\`` : `⏱ Timeout bei \`${trade.entry.toFixed(2)}\``}
💵 PnL: \`${pnl > 0 ? '+' : ''}${pnl.toFixed(2)} pts\`

🔥 Serie: \`${sd ? sd.performance.streak : 0}× ${sd ? (sd.performance.streakType || '-') : '-'}\`
📊 Heute: \`${sd ? sd.performance.wins : 0}W / ${sd ? sd.performance.losses : 0}L\` · Win-Rate \`${winRate}%\`

🕐 _${getBerlinTime()}_
⚡ _Apex Signal Bot_`;

    await sendTelegram(msg);
    console.log(`${emoji} ${result}: ${trade.signal} ${assetLabel} PnL ${pnl.toFixed(2)}`);
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

function buildOpeningRangeSignalMsg(signal, asset, entry, sl, tp, rr, bias, trend15m) {
  const dir = signal === 'BUY' ? '📈' : '📉';
  return `🟣 *OPENING RANGE BREAKOUT — ${asset}* ${dir}${biasTag(bias, signal)}

💰 *Entry:*       \`${entry.toFixed(2)}\`
🛑 *Stop Loss:*   \`${sl.toFixed(2)}\`
🎯 *Take Profit:* \`${tp.toFixed(2)}\`
⚖️ *Risk/Reward:* \`1 : ${rr}\`

📊 ${tf15Tag(trend15m, signal)}

🕐 _${getBerlinTime()}_
⚡ _Apex Signal Bot — Opening Range_`;
}

function buildSignalMsg(signal, asset, entry, sl, tp, rr, rsi, macd, bias, trend15m) {
  const emoji = signal === 'BUY' ? '🟢' : '🔴';
  const dir = signal === 'BUY' ? '📈' : '📉';
  return `${emoji} *${signal} NOW* — ${asset} ${dir}${biasTag(bias, signal)}

💰 *Entry:*       \`${entry.toFixed(2)}\`
🛑 *Stop Loss:*   \`${sl.toFixed(2)}\`
🎯 *Take Profit:* \`${tp.toFixed(2)}\`
⚖️ *Risk/Reward:* \`1 : ${rr}\`

📊 *Indikatoren:*
• RSI 14: \`${rsi}\`
• MACD: \`${macd}\`
${tf15Tag(trend15m, signal)}
• Alle 4 bestätigt ✅

🕐 _${getBerlinTime()} — ${getBerlinDate()}_
⚡ _Apex Signal Bot — Conservative Scalp_`;
}

function buildSwingSignalMsg(signal, asset, entry, sl, tp, rr, rsi, trend) {
  const dir = signal === 'BUY' ? '📈' : '📉';
  return `🟠 *SWING ${signal}* — ${asset} ${dir}

⏳ _Haltedauer: Stunden bis 1 Tag · 1H Chart_
📐 _Setup: Trend-Following + Pullback_

💰 *Entry:*       \`${entry.toFixed(2)}\`
🛑 *Stop Loss:*   \`${sl.toFixed(2)}\`
🎯 *Take Profit:* \`${tp.toFixed(2)}\`
⚖️ *Risk/Reward:* \`1 : ${rr}\`

📊 *Analyse (1H):*
• Trend: \`${trend}\`
• RSI 14: \`${rsi}\`
• Pullback zur EMA20 ✅

🕐 _${getBerlinTime()} — ${getBerlinDate()}_
⚡ _Apex Signal Bot — Swing Trade_`;
}

function buildPerformanceReport(asset, perf) {
  const total = perf.wins + perf.losses;
  const winRate = total > 0 ? ((perf.wins / total) * 100).toFixed(1) : '0';
  const totalPnl = perf.trades.reduce((a, t) => a + t.pnl, 0);
  const se = perf.streakType === 'WIN' ? '🔥' : perf.streakType === 'LOSS' ? '❄️' : '➡️';
  const last = perf.trades.slice(-5).map(t =>
    `${t.result === 'WIN' ? '✅' : '❌'} ${t.signal} · ${t.pnl > 0 ? '+' : ''}${t.pnl.toFixed(1)} pts`
  ).join('\n') || 'Keine abgeschlossenen Trades heute';

  return `📊 *TAGES-REPORT — ${asset}*
🗓 ${getBerlinDate()}

*Performance:*
✅ Wins: \`${perf.wins}\`  ❌ Losses: \`${perf.losses}\`
📈 Win-Rate: \`${winRate}%\`
💰 Total PnL: \`${totalPnl > 0 ? '+' : ''}${totalPnl.toFixed(2)} pts\`

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
    ].join('\n'));
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
                await sendTelegram(buildSwingSignalMsg(sw.signal, assetLabel, sw.cur, sw.sl, sw.tp, sw.rr, sw.rsi, sw.trend));
                openTrades.push({ symbol: normSym, signal: sw.signal, entry: sw.cur, sl: sw.sl, tp: sw.tp, rr: sw.rr, type: 'swing', timeoutMin: CONFIG.SWING_TIMEOUT_MIN, openedAt: Date.now() });
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
              const sl = bo === 'BUY' ? close - atrV * CONFIG.SL_MULT : close + atrV * CONFIG.SL_MULT;
              const tp = bo === 'BUY' ? close + atrV * CONFIG.TP_MULT : close - atrV * CONFIG.TP_MULT;
              const rr = (CONFIG.TP_MULT / CONFIG.SL_MULT).toFixed(2);
              const trend15m = get15MTrend(st.closes, st.highs, st.lows);
              await sendTelegram(buildOpeningRangeSignalMsg(bo, assetLabel, close, sl, tp, rr, sd.lastBias, trend15m));
              openTrades.push({ symbol: normSym, signal: bo, entry: close, sl, tp, rr, type: 'opening_range', openedAt: Date.now() });
              console.log(`🟣 Breakout: ${bo} ${assetLabel}`);
            }
          }

          // 4. Tages-Report (22:00) — nur einmal
          if (t >= T.REPORT && !sd.reportSent) {
            sd.reportSent = true;
            await sendTelegram(buildPerformanceReport(assetLabel, sd.performance));
            console.log(`📊 Report ${assetLabel}`);
          }
        }

        // 5. 4-Confirm Signal — nur wenn kein offener Trade UND kein Cooldown aktiv
        if (!hasOpenTrade(normSym) && !inCooldown(normSym)) {
          const result = runStrategy(st.closes, st.highs, st.lows);
          if (result) {
            const bias = sd?.lastBias || null;
            // Bias-Filter: nur Trades in Richtung des Daily Bias (wenn Bias gesetzt & aktiv)
            const biasBlocks = CONFIG.REQUIRE_BIAS_ALIGN
              && bias && bias !== 'WATCH' && bias !== 'NEUTRAL'
              && bias !== result.signal;

            const signalKey = `${result.signal}-${Math.round(result.cur)}`;
            if (!biasBlocks && st.lastSignal !== signalKey) {
              st.lastSignal = signalKey;
              const trend15m = get15MTrend(st.closes, st.highs, st.lows);
              await sendTelegram(buildSignalMsg(result.signal, assetLabel, result.cur, result.sl, result.tp, result.rr, result.rsi, result.macd, bias, trend15m));
              openTrades.push({ symbol: normSym, signal: result.signal, entry: result.cur, sl: result.sl, tp: result.tp, rr: result.rr, type: '4confirm', openedAt: Date.now() });
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
  console.log(`📊 Config: SL ${CONFIG.SL_MULT}×ATR · TP ${CONFIG.TP_MULT}×ATR · R:R 1:${(CONFIG.TP_MULT/CONFIG.SL_MULT).toFixed(2)}`);
  if (!TOKEN) console.warn('⚠️  BOT_TOKEN nicht gesetzt!');
});
