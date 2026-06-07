const https = require('https');
const http = require('http');

const TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = "-5280319758";

// ─── MATH ────────────────────────────────────────────────────────────────────
function sma(a, n) { if (a.length < n) return null; return a.slice(-n).reduce((x, y) => x + y, 0) / n; }
function ema(a, n) { if (a.length < n) return null; const k = 2 / (n + 1); let e = a.slice(0, n).reduce((x, y) => x + y, 0) / n; for (let i = n; i < a.length; i++) e = a[i] * k + e * (1 - k); return e; }
function rsiCalc(a, n = 14) { if (a.length < n + 1) return null; const ch = a.slice(-n - 1).map((p, i, arr) => i > 0 ? p - arr[i - 1] : 0).slice(1); const ag = ch.filter(c => c > 0).reduce((a, b) => a + b, 0) / n; const al = ch.filter(c => c < 0).map(c => -c).reduce((a, b) => a + b, 0) / n; return al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
function macdL(a) { const e12 = ema(a, 12), e26 = ema(a, 26); return e12 && e26 ? e12 - e26 : null; }
function atrCalc(prices, highs, lows, n = 14) {
  if (prices.length < n + 1) return null;
  const trs = prices.slice(-n - 1).map((p, i, a) => {
    if (i === 0) return 0;
    const h = highs ? highs[highs.length - n - 1 + i] : p * 1.001;
    const l = lows ? lows[lows.length - n - 1 + i] : p * 0.999;
    return Math.max(h - l, Math.abs(h - a[i - 1]), Math.abs(l - a[i - 1]));
  }).slice(1);
  return trs.reduce((a, b) => a + b, 0) / n;
}

// ─── MULTI-TIMEFRAME ─────────────────────────────────────────────────────────
// 1M candles → aggregate to 15M
function aggregateTo15M(closes, highs, lows) {
  const result = { closes: [], highs: [], lows: [] };
  const size = 15;
  for (let i = 0; i + size <= closes.length; i += size) {
    const slice = closes.slice(i, i + size);
    const hSlice = highs.slice(i, i + size);
    const lSlice = lows.slice(i, i + size);
    result.closes.push(slice[slice.length - 1]);
    result.highs.push(Math.max(...hSlice));
    result.lows.push(Math.min(...lSlice));
  }
  return result;
}

// ─── STRATEGY: 4-Confirm ─────────────────────────────────────────────────────
function runStrategy(closes, highs, lows) {
  if (closes.length < 70) return null;
  const cur = closes[closes.length - 1];
  const prev = closes.slice(0, -1);
  const e12n = ema(closes, 12), e26n = ema(closes, 26);
  const e12p = ema(prev, 12), e26p = ema(prev, 26);
  if (!e12n || !e26n || !e12p || !e26p) return null;
  const crossUp = e12p <= e26p && e12n > e26n;
  const crossDown = e12p >= e26p && e12n < e26n;
  const rv = rsiCalc(closes); if (rv === null) return null;
  const rsiBuy = rv >= 45 && rv <= 65, rsiSell = rv >= 35 && rv <= 55;
  const mn = macdL(closes), mp = macdL(prev); if (!mn || !mp) return null;
  const mBull = mn > 0 && mn > mp, mBear = mn < 0 && mn < mp;
  const s50 = sma(closes, 50); if (!s50) return null;
  const atrV = atrCalc(closes, highs, lows) || cur * 0.005;
  const buyS = crossUp && rsiBuy && mBull && cur > s50;
  const sellS = crossDown && rsiSell && mBear && cur < s50;
  if (!buyS && !sellS) return null;
  const signal = buyS ? 'BUY' : 'SELL';
  const sl = buyS ? parseFloat((cur - atrV * 1.5).toFixed(2)) : parseFloat((cur + atrV * 1.5).toFixed(2));
  const tp = buyS ? parseFloat((cur + atrV * 2.5).toFixed(2)) : parseFloat((cur - atrV * 2.5).toFixed(2));
  const rr = buyS ? ((tp - cur) / (cur - sl)).toFixed(2) : ((cur - tp) / (sl - cur)).toFixed(2);
  return { signal, sl, tp, rr, cur, rsi: rv.toFixed(1), macd: mn.toFixed(3) };
}

// check 15M trend direction
function get15MTrend(closes, highs, lows) {
  const tf15 = aggregateTo15M(closes, highs, lows);
  if (tf15.closes.length < 30) return null;
  const e12 = ema(tf15.closes, 12), e26 = ema(tf15.closes, 26);
  if (!e12 || !e26) return null;
  return e12 > e26 ? 'BUY' : 'SELL';
}

// ─── SESSION DATA ─────────────────────────────────────────────────────────────
const sessionData = {
  'XAUUSD': { asiaHigh: null, asiaLow: null, londonBrokeHigh: false, londonBrokeLow: false, biasSent: false, lastBias: null, date: null,
    openingRange: { high: null, low: null, candles: [], sent: false, breakoutSent: false },
    performance: { wins: 0, losses: 0, trades: [], streak: 0, bestStreak: 0, worstStreak: 0, currentStreakType: null },
    reportSent: false
  },
  'NDX': { asiaHigh: null, asiaLow: null, londonBrokeHigh: false, londonBrokeLow: false, biasSent: false, lastBias: null, date: null,
    openingRange: { high: null, low: null, candles: [], sent: false, breakoutSent: false },
    performance: { wins: 0, losses: 0, trades: [], streak: 0, bestStreak: 0, worstStreak: 0, currentStreakType: null },
    reportSent: false
  },
};

function getBerlinHour() {
  return parseInt(new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', hour12: false }));
}
function getBerlinMinute() {
  return parseInt(new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin', minute: '2-digit' }));
}
function getBerlinDate() {
  return new Date().toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' });
}
function getBerlinTime() {
  return new Date().toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' });
}

function resetDayIfNeeded(sd) {
  const today = getBerlinDate();
  if (sd.date !== today) {
    sd.asiaHigh = null; sd.asiaLow = null;
    sd.londonBrokeHigh = false; sd.londonBrokeLow = false;
    sd.biasSent = false; sd.lastBias = null; sd.date = today;
    sd.openingRange = { high: null, low: null, candles: [], sent: false, breakoutSent: false };
    sd.reportSent = false;
    console.log(`🔄 Day reset für ${today}`);
  }
}

function updateSessions(sd, high, low, close) {
  const hour = getBerlinHour();
  const min = getBerlinMinute();

  // Asia: 02:00–09:00
  if (hour >= 2 && hour < 9) {
    if (sd.asiaHigh === null || high > sd.asiaHigh) sd.asiaHigh = high;
    if (sd.asiaLow === null || low < sd.asiaLow) sd.asiaLow = low;
  }

  // London: 09:00–15:30
  if (hour >= 9 && (hour < 15 || (hour === 15 && min < 30))) {
    if (sd.asiaHigh && high > sd.asiaHigh) sd.londonBrokeHigh = true;
    if (sd.asiaLow && low < sd.asiaLow) sd.londonBrokeLow = true;
  }

  // NYC Opening Range: 15:30–15:45
  if ((hour === 15 && min >= 30) || (hour === 15 && min < 45)) {
    sd.openingRange.candles.push({ high, low, close });
    if (sd.openingRange.high === null || high > sd.openingRange.high) sd.openingRange.high = high;
    if (sd.openingRange.low === null || low < sd.openingRange.low) sd.openingRange.low = low;
  }
}

function calcDailyBias(sd) {
  if (!sd.asiaHigh || !sd.asiaLow || sd.biasSent) return null;
  const hour = getBerlinHour(), min = getBerlinMinute();
  if (!(hour === 15 && min >= 30) && hour < 15) return null;
  let bias = null, reason = '';
  if (sd.londonBrokeHigh && !sd.londonBrokeLow) {
    bias = 'SELL'; reason = 'London hat das Asia High gebrochen aber keinen Uptrend fortgesetzt → NYC drückt nach unten 📉';
  } else if (!sd.londonBrokeHigh && sd.londonBrokeLow) {
    bias = 'BUY'; reason = 'London hat das Asia Low gebrochen aber keinen Downtrend fortgesetzt → NYC dreht nach oben 📈';
  } else if (!sd.londonBrokeHigh && !sd.londonBrokeLow) {
    bias = 'WATCH'; reason = 'London hat weder High noch Low geholt → NYC wird zuerst manipulieren, dann Reversal ⚠️';
  } else {
    bias = 'NEUTRAL'; reason = 'London hat beide Seiten gebrochen → kein klarer Bias heute';
  }
  return { bias, reason, asiaHigh: sd.asiaHigh, asiaLow: sd.asiaLow };
}

function checkOpeningRangeBreakout(sd, close, high, low) {
  const hour = getBerlinHour(), min = getBerlinMinute();
  if (!sd.openingRange.high || !sd.openingRange.low) return null;
  if (hour === 15 && min < 45) return null; // Range noch nicht fertig
  if (sd.openingRange.breakoutSent) return null;
  if (close > sd.openingRange.high) return 'BUY';
  if (close < sd.openingRange.low) return 'SELL';
  return null;
}

// ─── PERFORMANCE TRACKER ─────────────────────────────────────────────────────
function updatePerformance(sd, signal, entry, sl, tp, currentPrice) {
  const won = signal === 'BUY' ? currentPrice >= tp : currentPrice <= tp;
  const lost = signal === 'BUY' ? currentPrice <= sl : currentPrice >= sl;
  if (!won && !lost) return;
  const result = won ? 'WIN' : 'LOSS';
  const pnl = won ? Math.abs(tp - entry) : -Math.abs(sl - entry);
  sd.performance.trades.push({ signal, entry, sl, tp, result, pnl, time: getBerlinTime() });
  if (result === 'WIN') {
    sd.performance.wins++;
    if (sd.performance.currentStreakType === 'WIN') {
      sd.performance.streak++;
    } else {
      sd.performance.streak = 1;
      sd.performance.currentStreakType = 'WIN';
    }
    if (sd.performance.streak > sd.performance.bestStreak) sd.performance.bestStreak = sd.performance.streak;
  } else {
    sd.performance.losses++;
    if (sd.performance.currentStreakType === 'LOSS') {
      sd.performance.streak++;
    } else {
      sd.performance.streak = 1;
      sd.performance.currentStreakType = 'LOSS';
    }
    if (sd.performance.streak > sd.performance.worstStreak) sd.performance.worstStreak = sd.performance.streak;
  }
}

// ─── TELEGRAM ────────────────────────────────────────────────────────────────
function sendTelegram(msg) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: CHAT_ID, text: msg, parse_mode: 'Markdown' });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = ''; res.on('data', d => data += d); res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

function buildBiasMsg(asset, bias, reason, asiaHigh, asiaLow) {
  const biasEmoji = bias === 'BUY' ? '📈 BULLISH' : bias === 'SELL' ? '📉 BEARISH' : bias === 'WATCH' ? '👀 WATCH' : '➡️ NEUTRAL';
  return `🔵 *DAILY BIAS — ${asset}*

📊 *Richtung:* ${biasEmoji}
🗓 *Datum:* ${getBerlinDate()}

🌏 *Asia Range:*
• High: \`${asiaHigh?.toFixed(2)}\`
• Low:  \`${asiaLow?.toFixed(2)}\`

💡 *Analyse:*
${reason}

⏰ _NYC Session startet jetzt!_
⚡ _Apex Signal Bot_`;
}

function buildOpeningRangeMsg(asset, rangeHigh, rangeLow) {
  return `🟣 *NYC OPENING RANGE — ${asset}*

📐 *Range High:* \`${rangeHigh?.toFixed(2)}\`
📐 *Range Low:*  \`${rangeLow?.toFixed(2)}\`
📏 *Range Größe:* \`${(rangeHigh - rangeLow).toFixed(2)} pts\`

⏳ _Warte auf Ausbruch aus der Range..._
🕐 _${getBerlinTime()}_
⚡ _Apex Signal Bot_`;
}

function buildOpeningRangeSignalMsg(signal, asset, price, sl, tp, rr, bias, trend15m) {
  const dir = signal === 'BUY' ? '📈' : '📉';
  const withBias = bias && bias !== 'WATCH' && bias !== 'NEUTRAL' && bias === signal;
  const againstBias = bias && bias !== 'WATCH' && bias !== 'NEUTRAL' && bias !== signal;
  const with15m = trend15m === signal;

  const biasLine = withBias ? '✅ *Mit Daily Bias bestätigt*' : againstBias ? '⚠️ *GEGEN Daily Bias — HIGH RISK!*' : '';
  const tfLine = with15m ? '✅ *15M Trend bestätigt*' : '⚠️ *Gegen 15M Trend*';

  return `🟣 *OPENING RANGE BREAKOUT — ${asset}* ${dir}

${biasLine}
${tfLine}

💰 *Entry:*       \`${price}\`
🛑 *Stop Loss:*   \`${sl}\`
🎯 *Take Profit:* \`${tp}\`
⚖️ *Risk/Reward:* \`1 : ${rr}\`

🕐 _${getBerlinTime()}_
⚡ _Apex Signal Bot — Opening Range_`;
}

function buildSignalMsg(signal, asset, price, sl, tp, rr, rsi, macd, bias, trend15m) {
  const emoji = signal === 'BUY' ? '🟢' : '🔴';
  const dir = signal === 'BUY' ? '📈' : '📉';
  const withBias = bias && bias !== 'WATCH' && bias !== 'NEUTRAL' && bias === signal;
  const againstBias = bias && bias !== 'WATCH' && bias !== 'NEUTRAL' && bias !== signal;
  const with15m = trend15m === signal;
  const biasLine = withBias ? '\n✅ *Mit Daily Bias* — Starkes Signal!' : againstBias ? '\n⚠️ *HIGH RISK* — Gegen Daily Bias!' : '';
  const tfLine = with15m ? '✅ 15M Trend bestätigt' : '⚠️ Gegen 15M Trend';

  return `${emoji} *${signal} NOW* — ${asset} ${dir}${biasLine}

💰 *Entry:*       \`${price}\`
🛑 *Stop Loss:*   \`${sl}\`
🎯 *Take Profit:* \`${tp}\`
⚖️ *Risk/Reward:* \`1 : ${rr}\`

📊 *Indikatoren:*
• RSI 14: \`${rsi}\`
• MACD: \`${macd}\`
• ${tfLine}
• Alle 4 bestätigt ✅

🕐 _${getBerlinTime()} — ${getBerlinDate()}_
⚡ _Apex Signal Bot — Conservative Scalp_`;
}

function buildPerformanceReport(asset, perf) {
  const total = perf.wins + perf.losses;
  const winRate = total > 0 ? ((perf.wins / total) * 100).toFixed(1) : '0';
  const totalPnl = perf.trades.reduce((a, t) => a + t.pnl, 0);
  const streakEmoji = perf.currentStreakType === 'WIN' ? '🔥' : perf.currentStreakType === 'LOSS' ? '❄️' : '➡️';

  return `📊 *TAGES-REPORT — ${asset}*
🗓 ${getBerlinDate()}

*Performance:*
✅ Wins: \`${perf.wins}\`
❌ Losses: \`${perf.losses}\`
📈 Win Rate: \`${winRate}%\`
💰 Total PnL: \`${totalPnl > 0 ? '+' : ''}${totalPnl.toFixed(2)} pts\`

*Streak:*
${streakEmoji} Aktuelle Serie: \`${perf.streak}x ${perf.currentStreakType || '-'}\`
🏆 Beste Win-Serie: \`${perf.bestStreak}x WIN\`
📉 Schlimmste Loss-Serie: \`${perf.worstStreak}x LOSS\`

*Letzte Trades:*
${perf.trades.slice(-5).map(t => `${t.result === 'WIN' ? '✅' : '❌'} ${t.signal} | ${t.result} | ${t.pnl > 0 ? '+' : ''}${t.pnl.toFixed(2)} pts`).join('\n') || 'Keine Trades heute'}

⚡ _Apex Signal Bot — Daily Report_`;
}

// ─── STORE ───────────────────────────────────────────────────────────────────
const store = {
  'XAUUSD': { closes: [], highs: [], lows: [], lastSignal: null },
  'NDX':    { closes: [], highs: [], lows: [], lastSignal: null },
  'NAS100': { closes: [], highs: [], lows: [], lastSignal: null },
};

function getStore(symbol) {
  const s = symbol.toUpperCase();
  if (store[s]) return store[s];
  if (s.includes('NAS') || s.includes('NDX') || s.includes('US100')) return store['NDX'];
  if (s.includes('XAU') || s.includes('GOLD')) return store['XAUUSD'];
  return null;
}
function getSessionKey(symbol) {
  const s = symbol.toUpperCase();
  if (s.includes('XAU') || s.includes('GOLD')) return 'XAUUSD';
  if (s.includes('NAS') || s.includes('NDX') || s.includes('US100')) return 'NDX';
  return null;
}
function getAssetLabel(symbol) {
  const s = symbol.toUpperCase();
  if (s.includes('XAU') || s.includes('GOLD')) return 'XAU/USD';
  if (s.includes('NAS') || s.includes('NDX') || s.includes('US100')) return 'NASDAQ 100';
  return symbol;
}

// ─── SERVER ──────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.method === 'GET' && req.url === '/') {
    const sd = sessionData['XAUUSD'];
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end([
      '⚡ Apex Signal Bot v2 läuft ✅',
      `🕐 Berlin: ${getBerlinTime()}`,
      '',
      `XAU/USD Kerzen: ${store['XAUUSD'].closes.length}`,
      `NDX Kerzen:     ${store['NDX'].closes.length}`,
      '',
      `Asia High: ${sd.asiaHigh || '-'} | Low: ${sd.asiaLow || '-'}`,
      `London broke High: ${sd.londonBrokeHigh} | Low: ${sd.londonBrokeLow}`,
      `Bias: ${sd.lastBias || '-'} | Gesendet: ${sd.biasSent}`,
      `Opening Range High: ${sd.openingRange.high || '-'} | Low: ${sd.openingRange.low || '-'}`,
      `Wins: ${sd.performance.wins} | Losses: ${sd.performance.losses}`,
    ].join('\n'));
  }

  if (req.method === 'POST' && req.url === '/webhook') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const symbol = data.symbol || data.ticker || '';
        const close = parseFloat(data.close);
        const high = parseFloat(data.high || data.close);
        const low = parseFloat(data.low || data.close);
        if (!symbol || isNaN(close)) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'Fehlende Felder' })); }

        const st = getStore(symbol);
        if (!st) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'Unbekanntes Symbol' })); }

        st.closes.push(close); st.highs.push(high); st.lows.push(low);
        if (st.closes.length > 300) { st.closes.shift(); st.highs.shift(); st.lows.shift(); }

        const sessionKey = getSessionKey(symbol);
        const assetLabel = getAssetLabel(symbol);
        const sd = sessionKey ? sessionData[sessionKey] : null;
        const hour = getBerlinHour(), min = getBerlinMinute();

        if (sd) {
          resetDayIfNeeded(sd);
          updateSessions(sd, high, low, close);

          // 1. Daily Bias um 15:30
          if (hour === 15 && min >= 30 && !sd.biasSent) {
            const biasResult = calcDailyBias(sd);
            if (biasResult) {
              sd.biasSent = true;
              sd.lastBias = biasResult.bias;
              await sendTelegram(buildBiasMsg(assetLabel, biasResult.bias, biasResult.reason, biasResult.asiaHigh, biasResult.asiaLow));
              console.log(`🔵 Bias gesendet: ${biasResult.bias} für ${assetLabel}`);
            }
          }

          // 2. Opening Range um 15:45
          if (hour === 15 && min >= 45 && !sd.openingRange.sent && sd.openingRange.high) {
            sd.openingRange.sent = true;
            await sendTelegram(buildOpeningRangeMsg(assetLabel, sd.openingRange.high, sd.openingRange.low));
            console.log(`🟣 Opening Range gesendet für ${assetLabel}`);
          }

          // 3. Opening Range Breakout
          if (sd.openingRange.sent && !sd.openingRange.breakoutSent) {
            const breakout = checkOpeningRangeBreakout(sd, close, high, low);
            if (breakout) {
              sd.openingRange.breakoutSent = true;
              const atrV = atrCalc(st.closes, st.highs, st.lows) || close * 0.005;
              const sl = breakout === 'BUY' ? parseFloat((close - atrV * 1.5).toFixed(2)) : parseFloat((close + atrV * 1.5).toFixed(2));
              const tp = breakout === 'BUY' ? parseFloat((close + atrV * 2.5).toFixed(2)) : parseFloat((close - atrV * 2.5).toFixed(2));
              const rr = breakout === 'BUY' ? ((tp - close) / (close - sl)).toFixed(2) : ((close - tp) / (sl - close)).toFixed(2);
              const trend15m = get15MTrend(st.closes, st.highs, st.lows);
              await sendTelegram(buildOpeningRangeSignalMsg(breakout, assetLabel, close.toFixed(2), sl, tp, rr, sd.lastBias, trend15m));
              console.log(`🟣 Opening Range Breakout: ${breakout} ${assetLabel}`);
            }
          }

          // 4. Tages-Report um 22:00
          if (hour === 22 && !sd.reportSent) {
            sd.reportSent = true;
            await sendTelegram(buildPerformanceReport(assetLabel, sd.performance));
            console.log(`📊 Report gesendet für ${assetLabel}`);
          }
        }

        // 5. 4-Confirm Signal
        const result = runStrategy(st.closes, st.highs, st.lows);
        if (result) {
          const signalKey = `${result.signal}-${result.cur.toFixed(0)}`;
          if (st.lastSignal !== signalKey) {
            st.lastSignal = signalKey;
            const trend15m = get15MTrend(st.closes, st.highs, st.lows);
            const bias = sd?.lastBias || null;
            const msg = buildSignalMsg(result.signal, assetLabel, result.cur, result.sl, result.tp, result.rr, result.rsi, result.macd, bias, trend15m);
            const tgRes = await sendTelegram(msg);
            console.log(`${result.signal === 'BUY' ? '🟢' : '🔴'} Signal: ${result.signal} ${assetLabel} | Telegram: ${tgRes.ok ? '✅' : '❌'}`);
            res.writeHead(200); return res.end(JSON.stringify({ ok: true, signal: result.signal }));
          }
        }

        res.writeHead(200); res.end(JSON.stringify({ ok: true, signal: 'WAIT', candles: st.closes.length }));
      } catch (e) {
        console.error('❌ Fehler:', e.message);
        res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Apex Signal Bot v2 läuft auf Port ${PORT}`);
  if (!TOKEN) console.warn('⚠️  BOT_TOKEN nicht gesetzt!');
});
