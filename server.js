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
    return Math.max(h - l, Math.abs(h - a[i-1]), Math.abs(l - a[i-1]));
  }).slice(1);
  return trs.reduce((a, b) => a + b, 0) / n;
}

// ─── STRATEGY: 4-Confirm Conservative Scalp ──────────────────────────────────
function runStrategy(closes, highs, lows) {
  if (closes.length < 70) return null;
  const cur = closes[closes.length - 1];
  const prev = closes.slice(0, -1);
  const e12n = ema(closes, 12), e26n = ema(closes, 26);
  const e12p = ema(prev, 12), e26p = ema(prev, 26);
  if (!e12n || !e26n || !e12p || !e26p) return null;
  const crossUp = e12p <= e26p && e12n > e26n;
  const crossDown = e12p >= e26p && e12n < e26n;
  const rv = rsiCalc(closes);
  if (rv === null) return null;
  const rsiBuy = rv >= 45 && rv <= 65;
  const rsiSell = rv >= 35 && rv <= 55;
  const mn = macdL(closes), mp = macdL(prev);
  if (!mn || !mp) return null;
  const mBull = mn > 0 && mn > mp;
  const mBear = mn < 0 && mn < mp;
  const s50 = sma(closes, 50);
  if (!s50) return null;
  const atrV = atrCalc(closes, highs, lows) || cur * 0.005;
  const buyS = crossUp && rsiBuy && mBull && cur > s50;
  const sellS = crossDown && rsiSell && mBear && cur < s50;
  if (!buyS && !sellS) return null;
  const signal = buyS ? 'BUY' : 'SELL';
  const sl = buyS ? parseFloat((cur - atrV * 1.5).toFixed(2)) : parseFloat((cur + atrV * 1.5).toFixed(2));
  const tp = buyS ? parseFloat((cur + atrV * 2.5).toFixed(2)) : parseFloat((cur - atrV * 2.5).toFixed(2));
  const rr = buyS ? ((tp - cur) / (cur - sl)).toFixed(2) : ((cur - tp) / (sl - cur)).toFixed(2);
  return { signal, sl, tp, rr, cur, rsi: rv.toFixed(1), macd: mn.toFixed(3), sma50: s50.toFixed(2) };
}

// ─── SESSION BIAS (Asia / London / NYC) ──────────────────────────────────────
// Zeitzonen: Berlin = UTC+2 (Sommer)
// Asia:   02:00 – 09:00 Uhr Berlin
// London: 09:00 – 15:30 Uhr Berlin
// NYC:    15:30 – 22:00 Uhr Berlin

const sessionData = {
  'XAUUSD': { asiaHigh: null, asiaLow: null, londonHigh: null, londonLow: null, londonBrokeHigh: false, londonBrokeLow: false, biasSent: false, date: null },
  'NDX':    { asiaHigh: null, asiaLow: null, londonHigh: null, londonLow: null, londonBrokeHigh: false, londonBrokeLow: false, biasSent: false, date: null },
};

function getBerlinHour() {
  const now = new Date();
  return parseInt(now.toLocaleString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', hour12: false }));
}

function getBerlinDate() {
  return new Date().toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' });
}

function updateSessionData(symbol, high, low, close) {
  const sd = sessionData[symbol];
  if (!sd) return;

  const hour = getBerlinHour();
  const today = getBerlinDate();

  // Reset at start of new day (Asia open ~02:00)
  if (sd.date !== today && hour >= 2) {
    sd.asiaHigh = null; sd.asiaLow = null;
    sd.londonHigh = null; sd.londonLow = null;
    sd.londonBrokeHigh = false; sd.londonBrokeLow = false;
    sd.biasSent = false; sd.date = today;
    console.log(`🔄 Session Reset für ${symbol} — neuer Tag: ${today}`);
  }

  // Asia Session: 02:00 – 09:00
  if (hour >= 2 && hour < 9) {
    if (sd.asiaHigh === null || high > sd.asiaHigh) sd.asiaHigh = high;
    if (sd.asiaLow === null || low < sd.asiaLow) sd.asiaLow = low;
  }

  // London Session: 09:00 – 15:30
  if (hour >= 9 && hour < 16) {
    if (sd.londonHigh === null || high > sd.londonHigh) sd.londonHigh = high;
    if (sd.londonLow === null || low < sd.londonLow) sd.londonLow = low;
    if (sd.asiaHigh && high > sd.asiaHigh) sd.londonBrokeHigh = true;
    if (sd.asiaLow && low < sd.asiaLow) sd.londonBrokeLow = true;
  }

  return sd;
}

function calcDailyBias(symbol) {
  const sd = sessionData[symbol];
  if (!sd || !sd.asiaHigh || !sd.asiaLow) return null;

  const hour = getBerlinHour();
  if (hour < 15) return null; // Noch nicht NYC Zeit
  if (sd.biasSent) return null; // Heute schon gesendet

  let bias = null;
  let reason = '';

  // Regel 1: Asien seitwärts, London manipuliert eine Richtung → NYC geht entgegengesetzt
  const asiaRange = sd.asiaHigh - sd.asiaLow;
  const londonBrokeOnly1Side = (sd.londonBrokeHigh && !sd.londonBrokeLow) || (!sd.londonBrokeHigh && sd.londonBrokeLow);

  if (londonBrokeOnly1Side) {
    if (sd.londonBrokeHigh) {
      bias = 'SELL';
      reason = 'London hat das Asia High gebrochen aber keinen Uptrend fortgesetzt → NYC drückt nach unten';
    } else {
      bias = 'BUY';
      reason = 'London hat das Asia Low gebrochen aber keinen Downtrend fortgesetzt → NYC dreht nach oben';
    }
  }

  // Regel 2: London holt weder High noch Low → NYC manipuliert, dann Reversal
  if (!sd.londonBrokeHigh && !sd.londonBrokeLow) {
    bias = 'WATCH';
    reason = 'London hat weder High noch Low von Asien geholt → NYC wird zuerst manipulieren, dann Reversal';
  }

  if (!bias) return null;
  return { bias, reason, asiaHigh: sd.asiaHigh, asiaLow: sd.asiaLow };
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

function buildSignalMsg(signal, asset, price, sl, tp, rr, rsi, macd, dailyBias) {
  const emoji = signal === 'BUY' ? '🟢' : '🔴';
  const dir = signal === 'BUY' ? '📈' : '📉';
  const time = new Date().toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' });
  const date = new Date().toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' });

  // Check ob Signal gegen den Daily Bias läuft
  const againstBias = dailyBias && dailyBias !== 'WATCH' && dailyBias !== signal;
  const withBias = dailyBias && dailyBias !== 'WATCH' && dailyBias === signal;

  const biasLine = againstBias
    ? `\n⚠️ *HIGH RISK* — Gegen Daily Bias (${dailyBias})!\n_Nur für erfahrene Trader — höheres Risiko!_`
    : withBias
    ? `\n✅ *Mit Daily Bias* (${dailyBias}) — Bestätigter Trade!`
    : '';

  return `${emoji} *${signal} NOW* — ${asset} ${dir}${biasLine}

💰 *Entry:*       \`${price}\`
🛑 *Stop Loss:*   \`${sl}\`
🎯 *Take Profit:* \`${tp}\`
⚖️ *Risk/Reward:* \`1 : ${rr}\`

📊 *Indikatoren:*
• RSI 14: \`${rsi}\`
• MACD: \`${macd}\`
• Alle 4 bestätigt ✅

📅 ${date} 🕐 ${time}
⚡ _Apex Signal Bot — Conservative Scalp_`;
}

function buildBiasMsg(asset, bias, reason, asiaHigh, asiaLow) {
  const emoji = bias === 'BUY' ? '🟢' : bias === 'SELL' ? '🔴' : '🟡';
  const date = new Date().toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' });
  return `${emoji} *DAILY BIAS — ${asset}*

🗓 *Datum:* ${date}
📊 *Bias:* \`${bias}\`

🌏 *Asia Range:*
• High: \`${asiaHigh?.toFixed(2)}\`
• Low:  \`${asiaLow?.toFixed(2)}\`

💡 *Analyse:*
${reason}

⏰ _NYC Session öffnet jetzt (15:30 Uhr)_
⚡ _Apex Signal Bot — Session Strategy_`;
}

// ─── PRICE STORE ─────────────────────────────────────────────────────────────
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
  if (s.includes('XAU') || s.includes('GOLD')) return 'XAU/USD (GOLD)';
  if (s.includes('NAS') || s.includes('NDX') || s.includes('US100')) return 'NASDAQ 100';
  return symbol;
}

// ─── HTTP SERVER ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // Health check
  if (req.method === 'GET' && req.url === '/') {
    const hour = getBerlinHour();
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end([
      '⚡ Apex Signal Bot läuft ✅',
      `🕐 Berlin Zeit: ${hour}:00 Uhr`,
      '',
      'Kerzen gespeichert:',
      `• XAU/USD: ${store['XAUUSD'].closes.length}`,
      `• NDX:     ${store['NDX'].closes.length}`,
      '',
      'Session Daten XAU/USD:',
      `• Asia High: ${sessionData['XAUUSD'].asiaHigh || 'noch nicht'}`,
      `• Asia Low:  ${sessionData['XAUUSD'].asiaLow || 'noch nicht'}`,
      `• London broke High: ${sessionData['XAUUSD'].londonBrokeHigh}`,
      `• London broke Low:  ${sessionData['XAUUSD'].londonBrokeLow}`,
      `• Bias heute gesendet: ${sessionData['XAUUSD'].biasSent}`,
    ].join('\n'));
  }

  // Webhook
  if (req.method === 'POST' && req.url === '/webhook') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        console.log('📨 Webhook:', body);
        const data = JSON.parse(body);
        const symbol = data.symbol || data.ticker || '';
        const close = parseFloat(data.close);
        const high = parseFloat(data.high || data.close);
        const low = parseFloat(data.low || data.close);

        if (!symbol || isNaN(close)) {
          res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'Fehlende Felder' }));
        }

        const st = getStore(symbol);
        if (!st) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'Unbekanntes Symbol' })); }

        // Kerzen speichern
        st.closes.push(close); st.highs.push(high); st.lows.push(low);
        if (st.closes.length > 200) { st.closes.shift(); st.highs.shift(); st.lows.shift(); }

        // Session Daten updaten
        const sessionKey = getSessionKey(symbol);
        if (sessionKey) updateSessionData(sessionKey, high, low, close);

        // 1. Daily Bias prüfen (NYC Open)
        const hour = getBerlinHour();
        if (sessionKey && hour >= 15 && hour < 16) {
          const biasResult = calcDailyBias(sessionKey);
          if (biasResult) {
            sessionData[sessionKey].biasSent = true;
            sessionData[sessionKey].lastBias = biasResult.bias;
            const assetLabel = getAssetLabel(symbol);
            const biasMsg = buildBiasMsg(assetLabel, biasResult.bias, biasResult.reason, biasResult.asiaHigh, biasResult.asiaLow);
            console.log(`📊 Daily Bias: ${biasResult.bias} für ${assetLabel}`);
            await sendTelegram(biasMsg);
          }
        }

        // 2. 4-Confirm Signal prüfen
        const result = runStrategy(st.closes, st.highs, st.lows);
        if (result) {
          const signalKey = `${result.signal}-${result.cur.toFixed(0)}`;
          if (st.lastSignal !== signalKey) {
            st.lastSignal = signalKey;
            const assetLabel = getAssetLabel(symbol);
            console.log(`🚨 Signal: ${result.signal} ${assetLabel}`);
            const currentBias = sessionKey ? sessionData[sessionKey]?.lastBias : null;
            const msg = buildSignalMsg(result.signal, assetLabel, result.cur, result.sl, result.tp, result.rr, result.rsi, result.macd, currentBias);
            const tgRes = await sendTelegram(msg);
            console.log('✈️ Telegram:', tgRes.ok ? '✅' : '❌ ' + tgRes.description);
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
  console.log(`🚀 Apex Signal Bot läuft auf Port ${PORT}`);
  if (!TOKEN) console.warn('⚠️  BOT_TOKEN nicht gesetzt!');
});
