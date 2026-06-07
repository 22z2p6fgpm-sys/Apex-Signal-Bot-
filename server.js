const https = require('https');
const http = require('http');

const TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = "-5280319758";

// ─── INDICATOR MATH ──────────────────────────────────────────────────────────
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

// ─── TELEGRAM ────────────────────────────────────────────────────────────────
function sendTelegram(signal, asset, price, sl, tp, rr, rsi, macd) {
  return new Promise((resolve, reject) => {
    const emoji = signal === 'BUY' ? '🟢' : '🔴';
    const dir = signal === 'BUY' ? '📈' : '📉';
    const time = new Date().toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' });
    const date = new Date().toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' });

    const msg =
`${emoji} *${signal} NOW* — ${asset} ${dir}

💰 *Entry:*      \`${price}\`
🛑 *Stop Loss:*  \`${sl}\`
🎯 *Take Profit:* \`${tp}\`
⚖️ *Risk/Reward:* \`1 : ${rr}\`

📊 *Indikatoren:*
• RSI 14: \`${rsi}\`
• MACD: \`${macd}\`
• Alle 4 bestätigt ✅

📅 ${date} 🕐 ${time}

⚡ _Apex Signal Bot — Conservative Scalp_`;

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

// ─── PRICE STORE (speichert die letzten 100 Kerzen pro Asset) ─────────────────
const store = {
  'XAUUSD': { closes: [], highs: [], lows: [], lastSignal: null },
  'NDX':    { closes: [], highs: [], lows: [], lastSignal: null },
  'NAS100': { closes: [], highs: [], lows: [], lastSignal: null },
};

function getStore(symbol) {
  const s = symbol.toUpperCase();
  if (store[s]) return store[s];
  // Alias mapping
  if (s.includes('NAS') || s.includes('NDX') || s.includes('US100')) return store['NDX'];
  if (s.includes('XAU') || s.includes('GOLD')) return store['XAUUSD'];
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
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end([
      '⚡ Apex Signal Bot läuft ✅',
      '',
      'Gespeicherte Kerzen:',
      `• XAU/USD: ${store['XAUUSD'].closes.length} Kerzen`,
      `• NDX:     ${store['NDX'].closes.length} Kerzen`,
      '',
      'Letztes Signal XAU/USD: ' + (store['XAUUSD'].lastSignal || 'keines'),
      'Letztes Signal NDX:     ' + (store['NDX'].lastSignal || 'keines'),
    ].join('\n'));
  }

  // TradingView Webhook endpoint
  if (req.method === 'POST' && req.url === '/webhook') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        console.log('📨 Webhook erhalten:', body);
        const data = JSON.parse(body);

        // TradingView schickt: { symbol, close, high, low, time }
        const symbol = data.symbol || data.ticker || '';
        const close = parseFloat(data.close);
        const high = parseFloat(data.high || data.close);
        const low = parseFloat(data.low || data.close);

        if (!symbol || isNaN(close)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'Fehlende Felder: symbol, close' }));
        }

        const st = getStore(symbol);
        if (!st) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'Unbekanntes Symbol: ' + symbol }));
        }

        // Kerze speichern (max 200)
        st.closes.push(close);
        st.highs.push(high);
        st.lows.push(low);
        if (st.closes.length > 200) { st.closes.shift(); st.highs.shift(); st.lows.shift(); }

        console.log(`📊 ${symbol}: close=${close} | Kerzen gespeichert: ${st.closes.length}`);

        // Strategie berechnen
        const result = runStrategy(st.closes, st.highs, st.lows);

        if (result) {
          const signalKey = `${result.signal}-${result.cur.toFixed(0)}`;
          if (st.lastSignal !== signalKey) {
            st.lastSignal = signalKey;
            const assetLabel = getAssetLabel(symbol);
            console.log(`🚨 Signal: ${result.signal} ${assetLabel} Entry:${result.cur} SL:${result.sl} TP:${result.tp}`);
            const tgRes = await sendTelegram(result.signal, assetLabel, result.cur, result.sl, result.tp, result.rr, result.rsi, result.macd);
            console.log('✈️ Telegram:', tgRes.ok ? '✅ Gesendet' : '❌ ' + tgRes.description);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true, signal: result.signal, entry: result.cur, sl: result.sl, tp: result.tp, telegram: tgRes.ok }));
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, signal: 'WAIT', candles: st.closes.length }));

      } catch (e) {
        console.error('❌ Fehler:', e.message);
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
  console.log(`🚀 Apex Signal Bot Server läuft auf Port ${PORT}`);
  console.log(`📡 Webhook URL: https://DEINE-URL.railway.app/webhook`);
  if (!TOKEN) console.warn('⚠️  BOT_TOKEN nicht gesetzt!');
});
