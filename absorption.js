// ═══════════════════════════════════════════════════════════════════════════
//  ABSORPTION-MODUL — Orderflow-Näherung aus dem 1M-Webhook-Feed
//  Gleiche Logik wie tradingview/apex-absorption.pine:
//   1. 1M-Kerzen → 5M-Kerzen (uhrzeit-genau), Delta je 1M-Kerze geschätzt
//      (Close-Position in der Kerze) und aufsummiert.
//   2. Absorptions-Kerze = viel Volumen + wenig Bewegung + Docht/Delta.
//      Verkauf-Absorption → Widerstands-Zone, Kauf-Absorption → Unterstützungs-Zone.
//   3. Signal, wenn der Preis eine Zone erneut antestet und abprallt.
//
//  ACHTUNG: Auf CFDs ist "volume" nur Tick-Volumen (Anzahl Preisänderungen),
//  kein echtes Kauf-/Verkaufsvolumen. Das hier ist eine NÄHERUNG.
//  Braucht im TradingView-Alert zusätzlich: "open", "volume" (und ideal "time").
//  Optional "delta" = echtes Kauf- minus Verkaufsvolumen (Futures-Orderflow) → ersetzt die Schätzung.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const CFG = {
  TF_MIN: Math.max(2, parseInt(process.env.ABSORPTION_TF || '5', 10) || 5),
  VOL_LEN: 20,          // Volumen-Durchschnitt (TF-Kerzen)
  VOL_MULT: 1.8,        // Mindest-Volumen × Durchschnitt
  EFFORT_MAX: 0.6,      // Kerzenkörper ≤ 0.6 × ATR  (viel Volumen, wenig Bewegung)
  WICK_MIN: 0.45,       // Docht-Anteil an der Kerze
  DELTA_MIN: 0.15,      // Delta-Anteil der aggressiven Seite
  ATR_LEN: 14,
  MAX_ZONES: 6,         // aktive Zonen je Seite
  ZONE_LIFE: 300,       // Zone verfällt nach N TF-Kerzen
  SL_BUF: 0.2,          // SL-Puffer hinter der Zone (× ATR)
  MIN_RR: 1.5,          // Mindest-CRV bis zur Gegen-Zone
  FALLBACK_RR: 2.0,     // Ziel ohne Gegen-Zone (× Risiko)
  INSTANT: process.env.ABSORPTION_INSTANT === 'true', // Signal direkt an der Absorptions-Kerze
  MAX_BARS: 400,
  FILTER_ATR: 0.5,      // Scalp-Filter: Gegen-Zone näher als 0.5 × ATR → blocken
  MIN_VOL_SHARE: 0.8,   // ≥80% der letzten Kerzen brauchen Volumen, sonst inaktiv
};
const TF_MS = CFG.TF_MIN * 60000;

function freshState() {
  return {
    cur: null,          // TF-Kerze im Bau
    bars: [],           // fertige TF-Kerzen {o,h,l,c,v,d,ts}
    zones: [],          // {top,bot,dir,vol,dPct,born,used,ts}
    seq: 0,             // Zähler fertiger Kerzen (für Zonen-Alter)
    prevClose: null,
    lastSignal: null,   // letztes Absorption-Signal (Info)
    lastMinute: null,   // Startzeit der zuletzt verarbeiteten 1M-Kerze
    volSeen: 0, volMissing: 0,
    filterChecks: 0, filterHits: 0,
    realDelta: 0,       // Anzahl 1M-Kerzen mit echtem Delta
  };
}
const state = { XAUUSD: freshState(), NDX: freshState() };
function S(key) { if (!state[key]) state[key] = freshState(); return state[key]; }

const num = (x) => (x === null || x === undefined || x === '' ? NaN : Number(x));
const r2 = (x) => parseFloat(Number(x).toFixed(2));

// Delta-Schätzung je Kerze: Close am Hoch = Käufer aggressiv, Close am Tief = Verkäufer
function clvDelta(o, h, l, c, v) {
  if (!(v > 0)) return 0;
  const r = h - l;
  if (r > 0) return v * ((c - l) - (h - c)) / r;
  return c > o ? v : c < o ? -v : 0;
}

function atrOf(bars, n) {
  if (bars.length < n + 1) return null;
  let s = 0;
  for (let i = bars.length - n; i < bars.length; i++) {
    const b = bars[i], pc = bars[i - 1].c;
    s += Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
  }
  return s / n;
}
function avgVolOf(bars, n) {
  if (bars.length < n) return null;
  let s = 0;
  for (let i = bars.length - n; i < bars.length; i++) s += bars[i].v || 0;
  return s / n;
}

// Startzeit der 1M-Kerze: aus {{time}} oder geschätzt (Webhook kommt kurz nach Kerzenschluss)
function minuteStart(time) {
  if (time != null && time !== '') {
    const t = typeof time === 'number' ? time : (/^\d+$/.test(String(time)) ? Number(time) : Date.parse(time));
    if (Number.isFinite(t)) return Math.floor(t / 60000) * 60000;
  }
  // Alert kommt nach Kerzenschluss → laufende Minute minus 1 = Start der gerade geschlossenen Kerze (robust bis 59 s Verzug)
  return Math.floor(Date.now() / 60000) * 60000 - 60000;
}

function isActive(st) {
  const total = st.volSeen + st.volMissing;
  if (total < 30) return st.volSeen > 0;
  return st.volSeen / total >= CFG.MIN_VOL_SHARE;
}

function target(st, dir, entry, risk) {
  if (!(risk > 0)) return null;
  let best = null;
  for (const z of st.zones) {
    if (dir === 1 && z.dir === -1 && z.bot > entry) best = best === null ? z.bot : Math.min(best, z.bot);
    if (dir === -1 && z.dir === 1 && z.top < entry) best = best === null ? z.top : Math.max(best, z.top);
  }
  if (best === null) return entry + dir * risk * CFG.FALLBACK_RR;
  return Math.abs(best - entry) / risk >= CFG.MIN_RR ? best : null;
}

// Fertige TF-Kerze auswerten → { bar, atr, newZone, signal }
function processBar(st, bar, allowSignal = true) {
  st.bars.push(bar);
  if (st.bars.length > CFG.MAX_BARS) st.bars.shift();
  st.seq++;

  const atr = atrOf(st.bars, CFG.ATR_LEN);
  const avgVol = avgVolOf(st.bars, CFG.VOL_LEN);
  const out = { bar, atr, newZone: null, signal: null };
  const rng = bar.h - bar.l;
  if (!(bar.v > 0) || atr === null || avgVol === null || !(rng > 0)) return out;

  const body = Math.abs(bar.c - bar.o);
  const upWick = bar.h - Math.max(bar.o, bar.c);
  const dnWick = Math.min(bar.o, bar.c) - bar.l;
  const dPct = bar.d / bar.v;

  // ── 1) Signale gegen bestehende Zonen ──
  let zS = null, zL = null;
  for (const z of (allowSignal ? st.zones : [])) {
    if (z.used) continue;
    if (z.dir === -1 && bar.h >= z.bot && bar.c < z.bot && bar.c < bar.o) { if (!zS || z.vol > zS.vol) zS = z; }
    if (z.dir === 1 && bar.l <= z.top && bar.c > z.top && bar.c > bar.o) { if (!zL || z.vol > zL.vol) zL = z; }
  }
  if (zS && !zL) {
    const sl = zS.top + atr * CFG.SL_BUF;
    const tp = target(st, -1, bar.c, sl - bar.c);
    if (tp !== null) { zS.used = true; out.signal = { signal: 'SELL', entry: r2(bar.c), sl: r2(sl), tp: r2(tp), why: 'Trapped Buyers', zoneTop: r2(zS.top), zoneBot: r2(zS.bot), zoneVol: zS.vol }; }
  } else if (zL && !zS) {
    const sl = zL.bot - atr * CFG.SL_BUF;
    const tp = target(st, 1, bar.c, bar.c - sl);
    if (tp !== null) { zL.used = true; out.signal = { signal: 'BUY', entry: r2(bar.c), sl: r2(sl), tp: r2(tp), why: 'Trapped Sellers', zoneTop: r2(zL.top), zoneBot: r2(zL.bot), zoneVol: zL.vol }; }
  }

  // ── 2) Absorption auf dieser Kerze? ──
  const avgOk = bar.v >= avgVol * CFG.VOL_MULT && body <= atr * CFG.EFFORT_MAX;
  const sellCand = avgOk && (upWick / rng >= CFG.WICK_MIN || (dPct >= CFG.DELTA_MIN && bar.c <= bar.o));
  const buyCand  = avgOk && (dnWick / rng >= CFG.WICK_MIN || (dPct <= -CFG.DELTA_MIN && bar.c >= bar.o));
  const sellAbs = sellCand && (!buyCand || upWick >= dnWick);
  const buyAbs  = buyCand && (!sellCand || dnWick > upWick);

  let instUsed = false;
  if (allowSignal && CFG.INSTANT && !out.signal && (sellAbs || buyAbs)) {
    const look = st.bars.slice(-20);
    if (buyAbs && bar.l <= Math.min(...look.map(b => b.l)) && bar.c > (bar.h + bar.l) / 2) {
      const sl = bar.l - atr * CFG.SL_BUF; const tp = target(st, 1, bar.c, bar.c - sl);
      if (tp !== null) { instUsed = true; out.signal = { signal: 'BUY', entry: r2(bar.c), sl: r2(sl), tp: r2(tp), why: 'Absorption am Tief', zoneTop: null, zoneBot: null, zoneVol: bar.v }; }
    } else if (sellAbs && bar.h >= Math.max(...look.map(b => b.h)) && bar.c < (bar.h + bar.l) / 2) {
      const sl = bar.h + atr * CFG.SL_BUF; const tp = target(st, -1, bar.c, sl - bar.c);
      if (tp !== null) { instUsed = true; out.signal = { signal: 'SELL', entry: r2(bar.c), sl: r2(sl), tp: r2(tp), why: 'Absorption am Hoch', zoneTop: null, zoneBot: null, zoneVol: bar.v }; }
    }
  }

  // ── 3) Durchbrochene / alte Zonen löschen ──
  st.zones = st.zones.filter(z => {
    const broken = (z.dir === -1 && bar.c > z.top + atr * 0.1) || (z.dir === 1 && bar.c < z.bot - atr * 0.1);
    return !broken && (st.seq - z.born) <= CFG.ZONE_LIFE;
  });

  // ── 4) Neue Zone ──
  if (sellAbs || buyAbs) {
    const dir = buyAbs ? 1 : -1;
    const minH = atr * 0.1;
    const top = dir === 1 ? Math.max(Math.min(bar.o, bar.c), bar.l + minH) : bar.h;
    const bot = dir === 1 ? bar.l : Math.min(Math.max(bar.o, bar.c), bar.h - minH);
    const z = { top: r2(top), bot: r2(bot), dir, vol: Math.round(bar.v), dPct: Math.round(Math.abs(dPct) * 100), born: st.seq, used: instUsed, ts: bar.ts };
    st.zones.push(z);
    out.newZone = z;
    const side = st.zones.filter(x => x.dir === dir);
    if (side.length > CFG.MAX_ZONES) {
      const oldest = side.reduce((a, b) => (b.born < a.born ? b : a));
      st.zones = st.zones.filter(x => x !== oldest);
    }
  }

  if (out.signal) st.lastSignal = { ...out.signal, ts: bar.ts };
  return out;
}

// Bei JEDER 1M-Kerze aufrufen. Gibt das Ergebnis der gerade fertig gewordenen
// TF-Kerze zurück ({bar, atr, newZone, signal, active}) oder null.
function feed(key, { open, high, low, close, volume, time, delta }) {
  const st = S(key);
  const h = num(high), l = num(low), c = num(close);
  if (![h, l, c].every(Number.isFinite)) return null;
  let o = num(open);
  if (!Number.isFinite(o)) o = st.prevClose != null ? st.prevClose : c;
  const ms = minuteStart(time);
  if (st.lastMinute != null && ms <= st.lastMinute) return null;   // doppelter / verspäteter Alert
  st.lastMinute = ms;
  let v = num(volume);
  if (Number.isFinite(v) && v > 0) st.volSeen++; else { st.volMissing++; v = 0; }
  st.prevClose = c;
  const bucket = Math.floor(ms / TF_MS);
  let result = null;

  // Kerze aus älterem Bucket nie abgeschlossen (Lücke/Wochenende) → jetzt abschließen, Signal verwerfen
  if (st.cur && st.cur.bucket !== bucket) {
    result = processBar(st, finish(st.cur), false);
    st.cur = null;
  }

  // Echtes Delta (Kauf- minus Verkaufs-Aggressor-Volumen, z. B. aus CME-Trades) hat Vorrang vor der Schätzung
  const dReal = num(delta);
  const d = Number.isFinite(dReal) ? Math.max(-v, Math.min(v, dReal)) : clvDelta(o, h, l, c, v);
  if (Number.isFinite(dReal)) st.realDelta++;
  if (!st.cur) st.cur = { bucket, o, h, l, c, v, d, ts: bucket * TF_MS };
  else { st.cur.h = Math.max(st.cur.h, h); st.cur.l = Math.min(st.cur.l, l); st.cur.c = c; st.cur.v += v; st.cur.d += d; }

  // Letzte Minute des Buckets → TF-Kerze fertig, sofort auswerten (kein 1-Min-Verzug)
  if ((ms + 60000) % TF_MS === 0) {
    result = processBar(st, finish(st.cur), isActive(st));
    st.cur = null;
  }
  if (result) result.active = isActive(st);
  return result;
}
function finish(cur) { return { o: cur.o, h: cur.h, l: cur.l, c: cur.c, v: cur.v, d: cur.d, ts: cur.ts }; }

// Scalp-Filter: läuft ein Signal direkt in eine aktive Gegen-Zone?
// Gibt einen Grund-Text zurück (→ blocken) oder null.
function blocks(key, signal, price) {
  const st = S(key);
  if (!isActive(st)) return null;
  const atr = atrOf(st.bars, CFG.ATR_LEN);
  if (atr === null) return null;
  st.filterChecks++;
  const maxDist = atr * CFG.FILTER_ATR;
  for (const z of st.zones) {
    if (signal === 'BUY' && z.dir === -1 && price <= z.top && z.bot - price <= maxDist) {
      st.filterHits++;
      return `Widerstand ${z.bot}–${z.top} (Absorption ${z.vol} | ${z.dPct}%) direkt über Entry`;
    }
    if (signal === 'SELL' && z.dir === 1 && price >= z.bot && price - z.top <= maxDist) {
      st.filterHits++;
      return `Unterstützung ${z.bot}–${z.top} (Absorption ${z.vol} | ${z.dPct}%) direkt unter Entry`;
    }
  }
  return null;
}

// Diagnose-Zeilen für /diag
function describe(key) {
  const st = S(key);
  const L = [];
  const total = st.volSeen + st.volMissing;
  if (total === 0) { L.push('noch keine Daten'); return L; }
  if (!isActive(st)) {
    L.push('INAKTIV — kein Volumen im Webhook (' + st.volSeen + '/' + total + ' Kerzen mit Volumen). Alert-Nachricht um "open"/"volume" erweitern.');
    return L;
  }
  const atr = atrOf(st.bars, CFG.ATR_LEN);
  L.push('aktiv · Delta ' + (st.realDelta > 0 ? 'ECHT' : 'geschätzt') + ' · ' + st.bars.length + ' ' + CFG.TF_MIN + 'M-Kerzen · ATR ' + (atr ? atr.toFixed(2) : 'Warmup') + ' · Filter ' + st.filterHits + '/' + st.filterChecks + ' geblockt');
  const res = st.zones.filter(z => z.dir === -1).sort((a, b) => a.bot - b.bot);
  const sup = st.zones.filter(z => z.dir === 1).sort((a, b) => b.top - a.top);
  L.push('Widerstand: ' + (res.length ? res.map(z => z.bot + '–' + z.top + ' (' + z.vol + '|' + z.dPct + '%' + (z.used ? ',genutzt' : '') + ')').join(' · ') : '–'));
  L.push('Unterstützung: ' + (sup.length ? sup.map(z => z.bot + '–' + z.top + ' (' + z.vol + '|' + z.dPct + '%' + (z.used ? ',genutzt' : '') + ')').join(' · ') : '–'));
  if (st.lastSignal) L.push('Letztes Signal: ' + st.lastSignal.signal + ' ' + st.lastSignal.why + ' @ ' + st.lastSignal.entry + ' SL ' + st.lastSignal.sl + ' TP ' + st.lastSignal.tp + ' (' + new Date(st.lastSignal.ts).toISOString().slice(5, 16).replace('T', ' ') + ' UTC)');
  return L;
}

function active(key) { return isActive(S(key)); }
function zonesFor(key) { return S(key).zones.map(z => ({ ...z })); }

// Persistenz (Railway-Volume, über saveState/loadState im server.js)
function getState() { return state; }
function setState(s) {
  if (!s || typeof s !== 'object') return;
  for (const k of Object.keys(s)) {
    const src = s[k];
    if (!src || typeof src !== 'object') continue;
    const st = freshState();
    if (Array.isArray(src.bars)) st.bars = src.bars.filter(b => b && Number.isFinite(b.h) && Number.isFinite(b.l)).slice(-CFG.MAX_BARS);
    if (Array.isArray(src.zones)) st.zones = src.zones.filter(z => z && Number.isFinite(z.top) && Number.isFinite(z.bot));
    for (const f of ['seq', 'prevClose', 'lastMinute', 'volSeen', 'volMissing', 'filterChecks', 'filterHits', 'realDelta']) if (Number.isFinite(src[f])) st[f] = src[f];
    if (src.cur && Number.isFinite(src.cur.bucket)) st.cur = src.cur;
    if (src.lastSignal) st.lastSignal = src.lastSignal;
    state[k] = st;
  }
}

function reset(key) { state[key] = freshState(); }

module.exports = { feed, blocks, describe, active, zonesFor, getState, setState, reset, CFG, _clvDelta: clvDelta };
