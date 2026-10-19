#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
//  Backtest für die Absorptions-Logik (absorption.js — exakt die Bot-Logik)
//
//  Eingabe: 1-Minuten-CSV
//    • aus fetch_databento.py  → time,open,high,low,close,volume,buy,sell,delta  (echtes Delta)
//    • TradingView-Export      → time,open,high,low,close,Volume                 (nur Schätzung)
//
//  Vergleicht "geschätzt" (wie heute im Bot) mit "echt" (Databento-Orderflow)
//  und einer Zufalls-Gegenprobe mit gleichem SL/TP-Abstand.
//
//    node backtest/backtest.js backtest/data/NQ_1m.csv --pv 20 --cost 0.75
//    node backtest/backtest.js export.csv --pv 2 --session ny
// ═══════════════════════════════════════════════════════════════════════════
'use strict';
const fs = require('fs');
const path = require('path');

// ─── Argumente ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (!argv.length || argv.includes('-h') || argv.includes('--help')) {
  console.log(`Aufruf: node backtest/backtest.js <datei.csv> [Optionen]
  --pv <$>          Dollar pro Punkt und Kontrakt (NQ 20 · MNQ 2 · GC 100 · MGC 10)  [20]
  --cost <Punkte>   Kosten pro Trade hin+zurück in Punkten (Slippage+Gebühr)        [0.75]
  --tf <Min>        Analyse-Zeiteinheit                                              [5]
  --timeout <Min>   Trade nach X Minuten schließen                                   [240]
  --session <s>     all | ny (nur 09:30–11:30 New York) | nyday (09:30–16:00)        [all]
  --modes <m>       est,real  (real nur mit delta/buy/sell-Spalten)                  [auto]
  --instant         auch Sofort-Signale an der Absorptions-Kerze
  --vol-mult <x>    Mindest-Volumen × Schnitt                                        [1.8]
  --effort <x>      max. Körper × ATR                                                [0.6]
  --min-rr <x>      Mindest-CRV bis zur Gegen-Zone                                   [1.5]
  --from/--to <YYYY-MM-DD>  Zeitraum eingrenzen
  --out <ordner>    Ausgabe-Ordner                                                   [backtest/out]`);
  process.exit(0);
}
const file = argv[0];
const opt = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def; };
const flag = (name) => argv.includes('--' + name);

const PV = parseFloat(opt('pv', '20'));
const COST = parseFloat(opt('cost', '0.75'));
const TF = parseInt(opt('tf', '5'), 10);
const TIMEOUT_MS = parseInt(opt('timeout', '240'), 10) * 60000;
const SESSION = opt('session', 'all');
const OUT = opt('out', path.join(__dirname, 'out'));
const FROM = opt('from', null), TO = opt('to', null);

process.env.ABSORPTION_TF = String(TF);              // muss VOR dem require gesetzt sein
const abs = require(path.join(__dirname, '..', 'absorption.js'));
abs.CFG.INSTANT = flag('instant');
abs.CFG.VOL_MULT = parseFloat(opt('vol-mult', abs.CFG.VOL_MULT));
abs.CFG.EFFORT_MAX = parseFloat(opt('effort', abs.CFG.EFFORT_MAX));
abs.CFG.MIN_RR = parseFloat(opt('min-rr', abs.CFG.MIN_RR));

// ─── CSV laden ───────────────────────────────────────────────────────────────
function parseTime(v) {
  const s = String(v).trim().replace(/^"|"$/g, '');
  if (/^\d+(\.\d+)?$/.test(s)) { const n = Number(s); return n < 1e11 ? n * 1000 : n; }  // Sekunden oder ms
  const t = Date.parse(s.includes('T') || s.includes('Z') ? s : s.replace(' ', 'T') + 'Z');
  return Number.isFinite(t) ? t : NaN;
}
function loadCsv(f) {
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean);
  const head = lines[0].split(/[,;]/).map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());
  const col = (...names) => head.findIndex(h => names.includes(h));
  const iT = col('time', 'timestamp', 'date', 'datetime'), iO = col('open'), iH = col('high'), iL = col('low'), iC = col('close');
  const iV = col('volume', 'vol'), iD = col('delta'), iB = col('buy', 'buy_volume'), iS = col('sell', 'sell_volume');
  if ([iT, iO, iH, iL, iC].some(i => i < 0)) throw new Error('CSV braucht Spalten time, open, high, low, close (gefunden: ' + head.join(', ') + ')');
  const sep = lines[0].includes(';') && !lines[0].includes(',') ? ';' : ',';
  const out = [];
  for (let k = 1; k < lines.length; k++) {
    const p = lines[k].split(sep);
    const c = { t: parseTime(p[iT]), open: +p[iO], high: +p[iH], low: +p[iL], close: +p[iC], volume: iV >= 0 ? +p[iV] : NaN };
    if (iD >= 0 && p[iD] !== '') c.delta = +p[iD];
    else if (iB >= 0 && iS >= 0) c.delta = (+p[iB]) - (+p[iS]);
    if (![c.t, c.open, c.high, c.low, c.close].every(Number.isFinite)) continue;
    out.push(c);
  }
  out.sort((a, b) => a.t - b.t);
  const from = FROM ? Date.parse(FROM + 'T00:00:00Z') : -Infinity, to = TO ? Date.parse(TO + 'T00:00:00Z') : Infinity;
  return out.filter(c => c.t >= from && c.t < to);
}

// ─── Zeit / Sessions (New York) ──────────────────────────────────────────────
const nyFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
function nyMinutes(t) { const [h, m] = nyFmt.format(new Date(t)).split(':').map(Number); return (h % 24) * 60 + m; }
function sessionOf(t) {
  const m = nyMinutes(t);
  if (m >= 570 && m < 690) return 'NY-Open 09:30–11:30';
  if (m >= 690 && m < 960) return 'NY-Tag 11:30–16:00';
  if (m >= 180 && m < 570) return 'London 03:00–09:30';
  if (m >= 960 && m < 1080) return 'Spät 16:00–18:00';
  return 'Asia 18:00–03:00';
}
function sessionAllowed(t) {
  if (SESSION === 'ny') return sessionOf(t).startsWith('NY-Open');
  if (SESSION === 'nyday') return sessionOf(t).startsWith('NY-');
  return true;
}

// ─── Trade vorwärts simulieren (konservativ: SL zuerst, wenn beides in einer Kerze) ──
function simulate(c, i0, dir, entry, sl, tp) {
  for (let j = i0 + 1; j < c.length; j++) {
    const k = c[j];
    const slHit = dir === 1 ? k.low <= sl : k.high >= sl;
    const tpHit = dir === 1 ? k.high >= tp : k.low <= tp;
    if (slHit) {
      const gap = dir === 1 ? Math.min(k.open, sl) : Math.max(k.open, sl);   // Gap über den SL → schlechterer Kurs
      return { j, exit: gap, reason: tpHit ? 'SL (TP+SL in 1 Kerze)' : 'SL' };
    }
    if (tpHit) return { j, exit: tp, reason: 'TP' };
    if (k.t - c[i0].t >= TIMEOUT_MS) return { j, exit: k.close, reason: 'Timeout' };
  }
  const last = c.length - 1;
  return { j: last, exit: c[last].close, reason: 'Datenende' };
}
function makeTrade(c, i0, dir, entry, sl, tp, extra) {
  const s = simulate(c, i0, dir, entry, sl, tp);
  const risk = Math.abs(entry - sl);
  const pts = dir * (s.exit - entry) - COST;
  return { time: new Date(c[i0].t).toISOString(), session: sessionOf(c[i0].t), signal: dir === 1 ? 'BUY' : 'SELL', entry, sl, tp,
    exit: +s.exit.toFixed(2), reason: s.reason, minutes: Math.round((c[s.j].t - c[i0].t) / 60000),
    risk: +risk.toFixed(2), rr: +(Math.abs(tp - entry) / risk).toFixed(2), pts: +pts.toFixed(2), R: +(pts / risk).toFixed(3), usd: +(pts * PV).toFixed(2), exitIdx: s.j, ...extra };
}

// ─── Ein Durchlauf mit der Bot-Logik ─────────────────────────────────────────
function run(mode, c) {
  const key = 'BT_' + mode;
  abs.reset(key);
  const trades = [];
  let busyUntil = -1, zones = 0, signals = 0;
  for (let i = 0; i < c.length; i++) {
    const k = c[i];
    const r = abs.feed(key, { open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume, time: k.t, delta: mode === 'real' ? k.delta : undefined });
    if (!r) continue;
    if (r.newZone) zones++;
    if (!r.signal) continue;
    signals++;
    if (i <= busyUntil || !sessionAllowed(k.t)) continue;           // wie im Bot: nur 1 Position gleichzeitig
    const s = r.signal, dir = s.signal === 'BUY' ? 1 : -1;
    const t = makeTrade(c, i, dir, k.close, s.sl, s.tp, { why: s.why });
    trades.push(t);
    busyUntil = t.exitIdx;
  }
  return { trades, zones, signals };
}

// ─── Zufalls-Gegenprobe: gleiche Anzahl Trades, gleiche SL/TP-Abstände, Zeitpunkt + Richtung zufällig ──
function baseline(c, ref, rounds = 30) {
  if (!ref.length) return null;
  let seed = 12345;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const eligible = [];
  for (let i = 0; i < c.length - 1; i++) if (sessionAllowed(c[i].t)) eligible.push(i);
  if (!eligible.length) return null;
  let sumR = 0, sumWin = 0, n = 0;
  for (let r = 0; r < rounds; r++) {
    for (const t of ref) {
      const i = eligible[Math.floor(rnd() * eligible.length)];
      const dir = rnd() < 0.5 ? 1 : -1, e = c[i].close;
      const x = makeTrade(c, i, dir, e, e - dir * t.risk, e + dir * t.risk * t.rr, {});
      sumR += x.R; sumWin += x.R > 0 ? 1 : 0; n++;
    }
  }
  return { avgR: sumR / n, winRate: sumWin / n, totalR: sumR / rounds };
}

// ─── Statistik ───────────────────────────────────────────────────────────────
function stats(tr) {
  const n = tr.length;
  if (!n) return { n: 0 };
  const wins = tr.filter(t => t.R > 0), losses = tr.filter(t => t.R <= 0);
  const sum = (a, f) => a.reduce((s, t) => s + f(t), 0);
  let eq = 0, peak = 0, dd = 0;
  for (const t of tr) { eq += t.R; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  const gw = sum(wins, t => t.R), gl = -sum(losses, t => t.R);   // Profit-Faktor in R (festes Risiko pro Trade)
  const avgRR = sum(tr, t => t.rr) / n;
  return {
    n, winRate: wins.length / n, avgR: sum(tr, t => t.R) / n, totalR: sum(tr, t => t.R), usd: sum(tr, t => t.usd),
    pf: gl > 0 ? gw / gl : Infinity, maxDD_R: dd, avgRR, breakevenWR: 1 / (1 + avgRR),
    tp: tr.filter(t => t.reason === 'TP').length, sl: tr.filter(t => t.reason.startsWith('SL')).length, timeout: tr.filter(t => t.reason === 'Timeout').length,
  };
}
const pct = (x) => (x * 100).toFixed(1) + '%';
const fmtUsd = (x) => (x >= 0 ? '+' : '−') + '$' + Math.abs(x).toLocaleString('de-DE', { maximumFractionDigits: 0 });
function line(label, s) {
  if (!s.n) return `${label.padEnd(24)} keine Trades`;
  return `${label.padEnd(24)} ${String(s.n).padStart(4)} Trades · Treffer ${pct(s.winRate).padStart(6)} (Break-even ~${pct(s.breakevenWR)}) · Ø ${(s.avgR >= 0 ? '+' : '') + s.avgR.toFixed(2)}R · Summe ${(s.totalR >= 0 ? '+' : '') + s.totalR.toFixed(1)}R · PF ${s.pf === Infinity ? '∞' : s.pf.toFixed(2)} · ${fmtUsd(s.usd)}`;
}

// ─── Los ─────────────────────────────────────────────────────────────────────
let candles;
try { candles = loadCsv(file); }
catch (e) { console.error('❌ ' + (e.code === 'ENOENT' ? 'Datei nicht gefunden: ' + file : e.message)); process.exit(1); }
if (candles.length < 500) { console.error(`❌ Nur ${candles.length} Kerzen – zu wenig für einen Backtest.`); process.exit(1); }
const hasDelta = candles.filter(c => Number.isFinite(c.delta)).length > candles.length * 0.9;
const hasVol = candles.filter(c => c.volume > 0).length > candles.length * 0.8;
if (!hasVol) { console.error('❌ Die Datei hat kein (oder kaum) Volumen – Absorption lässt sich so nicht testen.'); process.exit(1); }
let modes = opt('modes', hasDelta ? 'est,real' : 'est').split(',').map(s => s.trim()).filter(Boolean);
if (!hasDelta && modes.includes('real')) { console.warn('⚠️  Keine delta/buy/sell-Spalten → nur Modus "est".'); modes = modes.filter(m => m !== 'real'); }

const days = new Set(candles.map(c => new Date(c.t).toISOString().slice(0, 10))).size;
console.log(`\n📊 Absorption-Backtest · ${path.basename(file)}`);
console.log(`   ${candles.length.toLocaleString('de-DE')} Minuten · ${days} Handelstage · ${new Date(candles[0].t).toISOString().slice(0, 10)} → ${new Date(candles[candles.length - 1].t).toISOString().slice(0, 10)}`);
console.log('   R = Ergebnis bei festem Risiko pro Trade (wie Prop-Modus) · $ = bei festen 1 Kontrakt');
console.log(`   ${TF}M · Session ${SESSION} · Kosten ${COST} Pkt/Trade · $${PV}/Pkt · Timeout ${TIMEOUT_MS / 60000} Min · Sofort-Signale ${abs.CFG.INSTANT ? 'an' : 'aus'} · Vol×${abs.CFG.VOL_MULT} · Körper≤${abs.CFG.EFFORT_MAX}×ATR · CRV≥${abs.CFG.MIN_RR}`);

fs.mkdirSync(OUT, { recursive: true });
const summary = { file: path.basename(file), minutes: candles.length, days, settings: { tf: TF, session: SESSION, cost: COST, pv: PV, instant: abs.CFG.INSTANT, volMult: abs.CFG.VOL_MULT, effort: abs.CFG.EFFORT_MAX, minRR: abs.CFG.MIN_RR }, results: {} };
const label = { est: 'GESCHÄTZT (wie Bot heute)', real: 'ECHTER Orderflow' };

for (const m of modes) {
  const { trades, zones, signals } = run(m, candles);
  const s = stats(trades);
  const b = baseline(candles, trades);
  console.log(`\n── ${label[m] || m} ── ${zones} Zonen · ${signals} Signale`);
  console.log('   ' + line('Gesamt', s));
  if (b) console.log(`   ${'Zufall (Gegenprobe)'.padEnd(24)} Treffer ${pct(b.winRate)} · Ø ${(b.avgR >= 0 ? '+' : '') + b.avgR.toFixed(2)}R · Summe ${(b.totalR >= 0 ? '+' : '') + b.totalR.toFixed(1)}R`);
  if (s.n) {
    console.log(`   Ausgänge: ${s.tp} TP · ${s.sl} SL · ${s.timeout} Timeout · max. Drawdown ${s.maxDD_R.toFixed(1)}R · Ø CRV ${s.avgRR.toFixed(2)}`);
    for (const d of ['BUY', 'SELL']) console.log('   ' + line(d === 'BUY' ? 'Long' : 'Short', stats(trades.filter(t => t.signal === d))));
    const sess = [...new Set(trades.map(t => t.session))].sort();
    for (const ss of sess) console.log('   ' + line(ss, stats(trades.filter(t => t.session === ss))));
    const csv = ['time,session,signal,why,entry,sl,tp,exit,reason,minutes,risk,rr,pts,R,usd']
      .concat(trades.map(t => [t.time, t.session, t.signal, t.why, t.entry, t.sl, t.tp, t.exit, t.reason, t.minutes, t.risk, t.rr, t.pts, t.R, t.usd].join(',')));
    fs.writeFileSync(path.join(OUT, `trades_${m}.csv`), csv.join('\n'));
  }
  summary.results[m] = { ...s, zones, signals, baseline: b };
}

// Ehrliche Einordnung
console.log('\n── Einordnung ──');
for (const m of modes) {
  const r = summary.results[m];
  if (!r.n) { console.log(`   ${label[m]}: keine Trades – Parameter zu streng oder zu wenig Daten.`); continue; }
  const notes = [];
  if (r.n < 100) notes.push(`nur ${r.n} Trades – statistisch noch wenig belastbar (Ziel: 100+)`);
  if (r.baseline && r.avgR <= r.baseline.avgR + 0.05) notes.push('nicht besser als Zufall mit gleichem SL/TP');
  if (r.avgR <= 0) notes.push('nach Kosten kein Gewinn');
  if (r.avgR > 0 && r.baseline && r.avgR > r.baseline.avgR + 0.05 && r.n >= 100) notes.push('positiv und besser als Zufall → als Nächstes auf anderem Zeitraum gegenprüfen');
  console.log(`   ${label[m]}: ${notes.join(' · ') || 'unauffällig'}`);
}
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(`\n💾 Trades + summary.json in ${OUT}\n`);
