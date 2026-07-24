// ═══════════════════════════════════════════════════════════════════════════
//  broker.js — MetaApi (MetaTrader 5) Ausführungs-Schicht für den Apex Bot
//  Platziert Orders auf deinem MT5-DEMO. Dry-Run ist Default: es wird NICHTS
//  geordert, bis EXECUTE_TRADES=true gesetzt ist. Nur ein DEMO-Konto verbinden!
// ═══════════════════════════════════════════════════════════════════════════
//
//  Benötigte Environment-Variablen (Railway):
//    METAAPI_TOKEN        – dein MetaApi-Token (app.metaapi.cloud/token)
//    METAAPI_ACCOUNT_ID   – die Account-ID deines MT5-Demo in MetaApi
//    EXECUTE_TRADES       – 'true' = echte Orders (auf Demo). Default: Dry-Run
//    MT5_SYMBOL_XAUUSD    – Broker-Symbol für Gold (z.B. 'XAUUSD', 'GOLD', 'XAUUSD.r')
//    MT5_SYMBOL_NDX       – Broker-Symbol für Nasdaq (z.B. 'NAS100', 'US100', 'USTEC')
//    LOT_XAUUSD           – Lot pro Gold-Trade  (Default 0.01)
//    LOT_NDX              – Lot pro Nasdaq-Trade (Default 0.01)
//    MAX_OPEN_BROKER      – max. gleichzeitige Broker-Positionen (Default 6)
// ───────────────────────────────────────────────────────────────────────────

const EXECUTE   = process.env.EXECUTE_TRADES === 'true';
const TOKEN     = process.env.METAAPI_TOKEN;
const ACCOUNT_ID = process.env.METAAPI_ACCOUNT_ID;

const SYMBOL_MAP = {
  'XAUUSD': process.env.MT5_SYMBOL_XAUUSD || 'XAUUSD',
  'NDX':    process.env.MT5_SYMBOL_NDX    || 'NAS100',
};
const LOT_MAP = {
  'XAUUSD': parseFloat(process.env.LOT_XAUUSD || '0.01'),
  'NDX':    parseFloat(process.env.LOT_NDX    || '0.01'),
};
const MAX_OPEN = parseInt(process.env.MAX_OPEN_BROKER || '6', 10);

// ── Swing: Risiko-basiertes Sizing ──
// Der Bot rechnet die Swing-Lot so, dass der SL ~SWING_RISK_EUR Verlust bedeutet.
const RISK_SWING_EUR = parseFloat(process.env.SWING_RISK_EUR || '600');
// EUR-Wert einer Preis-Einheit (1.0) pro 1.0 Lot — empirisch aus echten Fills abgeleitet.
// Falls das Risiko am Konto nicht ~SWING_RISK_EUR trifft, hier (oder per Env) feinjustieren.
const EUR_PER_PRICE = {
  'XAUUSD': parseFloat(process.env.EUR_PER_PRICE_XAUUSD || '87'),   // Gold: 1.0 Preis ≈ 87€/Lot
  'NDX':    parseFloat(process.env.EUR_PER_PRICE_NDX    || '0.87'), // NAS100: 1.0 Punkt ≈ 0.87€/Lot
};

let connection = null;
let ready = false;
let openCount = 0;

// Erfolg prüfen (SDK-Version-tolerant)
function ok(res) {
  if (!res) return false;
  return res.stringCode === 'TRADE_RETCODE_DONE' || res.description === 'TRADE_RETCODE_DONE';
}

// Verbindung aufbauen — wird beim Serverstart einmal aufgerufen.
async function init() {
  if (!TOKEN || !ACCOUNT_ID) {
    console.log('ℹ️ Broker: METAAPI_TOKEN/ACCOUNT_ID fehlen → Ausführung deaktiviert (nur Signale/Telegram).');
    return;
  }
  try {
    // Lazy-Require: Bot läuft auch ohne installiertes SDK weiter (nur ohne Trading)
    const MetaApi = require('metaapi.cloud-sdk').default;
    // WICHTIG: Beim JavaScript-SDK darf KEINE region an den MetaApi-Konstruktor
    // übergeben werden (nur Java-SDK braucht das). Das SDK ermittelt die Region
    // selbst über das Konto. Ein region-Param hier verursacht Dauer-Timeouts.
    const api = new MetaApi(TOKEN);
    const account = await api.metatraderAccountApi.getAccount(ACCOUNT_ID);
    await account.deploy().catch(() => {}); // idempotent — falls schon deployed
    await account.waitConnected();
    connection = account.getRPCConnection();
    await connection.connect();
    await connection.waitSynchronized();
    ready = true;
    const info = await connection.getAccountInformation().catch(() => null);
    console.log(`✅ Broker verbunden (MT5). EXECUTE_TRADES=${EXECUTE ? 'AN — es wird geordert!' : 'aus (Dry-Run)'}` +
      (info ? ` · Balance ${info.balance} ${info.currency}` : ''));
  } catch (e) {
    console.warn('⚠️ Broker-Init fehlgeschlagen → Ausführung deaktiviert:', e.message);
    ready = false;
  }
}

function status() {
  return { ready, execute: EXECUTE, openCount, maxOpen: MAX_OPEN };
}

// Symbol-Spezifikation (digits, volumeStep, min/maxVolume), gecacht
const specCache = {};
async function getSpec(symbol) {
  if (specCache[symbol]) return specCache[symbol];
  try { specCache[symbol] = (await connection.getSymbolSpecification(symbol)) || {}; }
  catch { specCache[symbol] = {}; }
  return specCache[symbol];
}
const round = (v, d) => parseFloat(Number(v).toFixed(d));
// Volumen auf die erlaubte Schrittweite abrunden (nie über das Risiko-Budget) + Grenzen
function roundVolume(v, spec) {
  const step = spec.volumeStep || 0.01;
  let vol = Math.floor(v / step) * step;
  const min = spec.minVolume || step;
  const max = spec.maxVolume || 100;
  vol = Math.min(Math.max(vol, min), max);
  return parseFloat(vol.toFixed(2));
}

// Öffnet eine Market-Position. SL/TP werden RELATIV zum echten Broker-Preis gesetzt,
// damit der Preis-Versatz (TradingView vs. Vantage) egal ist.
//   entry/sl/tp = TradingView-Preise (nur zur Abstands-Berechnung genutzt)
// Rückgabe: { positionId, brokerEntry } oder null.
async function openTrade({ sessionKey, signal, entry, sl, tp, type, tag }) {
  const symbol = SYMBOL_MAP[sessionKey];
  const slDist = Math.abs(entry - sl);   // Abstand Entry→SL (aus TradingView-Preisen)
  const tpDist = Math.abs(tp - entry);   // Abstand Entry→TP3

  if (!EXECUTE) {
    // Auch im Dry-Run die geplante Lot berechnen, damit die Anzeige stimmt
    let dryVol = LOT_MAP[sessionKey];
    if (type === 'swing' && RISK_SWING_EUR > 0 && EUR_PER_PRICE[sessionKey] > 0 && slDist > 0) {
      dryVol = Math.max(0.01, Math.floor((RISK_SWING_EUR / (slDist * EUR_PER_PRICE[sessionKey])) / 0.01) * 0.01);
      dryVol = parseFloat(dryVol.toFixed(2));
    }
    console.log(`🧪 [DRY-RUN] würde öffnen: ${signal} ${symbol} (${type} · ${dryVol} Lot · SL-Abstand ${slDist.toFixed(2)})`);
    return { positionId: `DRY-${Date.now()}`, brokerEntry: entry, volume: dryVol };
  }
  if (!ready)   { console.warn(`⚠️ Broker nicht bereit — ${signal} ${symbol} NICHT ausgeführt`); return null; }
  if (openCount >= MAX_OPEN) { console.warn(`⚠️ MAX_OPEN_BROKER (${MAX_OPEN}) erreicht — ${signal} ${symbol} übersprungen`); return null; }

  try {
    const spec = await getSpec(symbol);
    const d = (typeof spec.digits === 'number') ? spec.digits : 2;

    // ── Volumen bestimmen ──
    // Swing: risiko-basiert (SL ≈ SWING_RISK_EUR). Scalp/Range: feste Lot.
    let volume;
    if (type === 'swing' && RISK_SWING_EUR > 0 && EUR_PER_PRICE[sessionKey] > 0 && slDist > 0) {
      const raw = RISK_SWING_EUR / (slDist * EUR_PER_PRICE[sessionKey]);
      volume = roundVolume(raw, spec);
      console.log(`🎯 Swing-Sizing ${symbol}: ${RISK_SWING_EUR}€ / (${slDist.toFixed(2)} × ${EUR_PER_PRICE[sessionKey]}€) → ${volume} Lot (~${(volume * slDist * EUR_PER_PRICE[sessionKey]).toFixed(0)}€ Risiko)`);
    } else {
      volume = LOT_MAP[sessionKey];
    }

    const label = `${signal} ${symbol} (${type}, ${volume} Lot · SL-Abstand ${slDist.toFixed(2)} · TP-Abstand ${tpDist.toFixed(2)})`;

    // Echten Vantage-Preis holen (Ask für BUY, Bid für SELL)
    const price = await connection.getSymbolPrice(symbol);
    const p = signal === 'BUY' ? price.ask : price.bid;
    if (!p || isNaN(p)) { console.error(`❌ Kein Broker-Preis für ${symbol} — Order übersprungen`); return null; }

    const brokerSL = round(signal === 'BUY' ? p - slDist : p + slDist, d);
    const brokerTP = round(signal === 'BUY' ? p + tpDist : p - tpDist, d);

    // Minimale Optionen — je weniger Felder, desto weniger Validierungs-Fallstricke
    const opts = { comment: 'ApexBot' };
    const res = signal === 'BUY'
      ? await connection.createMarketBuyOrder(symbol, volume, brokerSL, brokerTP, opts)
      : await connection.createMarketSellOrder(symbol, volume, brokerSL, brokerTP, opts);

    if (ok(res) && res.positionId) {
      openCount++;
      console.log(`📈 Broker OPEN: ${label} @Vantage ${p} → SL ${brokerSL} TP ${brokerTP} · Pos ${res.positionId}`);
      return { positionId: res.positionId, brokerEntry: p, volume };
    }
    console.error(`❌ Broker-Order abgelehnt: ${res && (res.stringCode || res.description || res.message)} — ${label}`);
    return null;
  } catch (e) {
    // MetaApi-ValidationError enthält ein details-Array mit dem konkreten Feld — das brauchen wir!
    let extra = '';
    try {
      if (e.details) extra = ' · DETAILS: ' + JSON.stringify(e.details);
      else if (e.metadata) extra = ' · META: ' + JSON.stringify(e.metadata);
    } catch (_) {}
    console.error(`❌ Broker openTrade Fehler (${label}): ${e.message}${extra}`);
    return null;
  }
}

// Setzt den SL einer Position auf Break-Even (Entry). TP bleibt erhalten.
async function moveToBreakeven(positionId, entryPrice, tp) {
  if (!positionId) return;
  if (!EXECUTE || String(positionId).startsWith('DRY-')) { console.log(`🧪 [DRY-RUN] würde SL→BE setzen: Pos ${positionId} @${entryPrice}`); return; }
  if (!ready) return;
  try {
    const res = await connection.modifyPosition(positionId, entryPrice, tp);
    console.log(ok(res) ? `🛡 Broker SL→BE: Pos ${positionId} @${entryPrice}` : `⚠️ SL→BE fehlgeschlagen: ${res && res.stringCode}`);
  } catch (e) {
    console.error(`❌ Broker moveToBreakeven Fehler (Pos ${positionId}):`, e.message);
  }
}

// Zieht den SL einer Position nach (Trailing). TP bleibt erhalten.
async function modifyStop(positionId, stopLoss, tp) {
  if (!positionId) return;
  if (!EXECUTE || String(positionId).startsWith('DRY-')) { console.log(`🧪 [DRY-RUN] würde SL nachziehen: Pos ${positionId} → ${stopLoss}`); return; }
  if (!ready) return;
  try {
    const res = await connection.modifyPosition(positionId, stopLoss, tp);
    if (!ok(res)) console.log(`⚠️ Trailing-SL fehlgeschlagen (Pos ${positionId}): ${res && res.stringCode}`);
  } catch (e) {
    console.error(`❌ Broker modifyStop Fehler (Pos ${positionId}):`, e.message);
  }
}

// Schließt eine Position. "Already closed"-Fehler werden ignoriert.
async function closeTrade(positionId) {
  if (!positionId) return;
  if (!EXECUTE || String(positionId).startsWith('DRY-')) { console.log(`🧪 [DRY-RUN] würde schließen: Pos ${positionId}`); return; }
  if (!ready) return;
  try {
    const res = await connection.closePosition(positionId);
    if (ok(res)) { openCount = Math.max(0, openCount - 1); console.log(`🔻 Broker CLOSE: Pos ${positionId}`); }
    else console.log(`ℹ️ Close-Antwort für Pos ${positionId}: ${res && res.stringCode}`);
  } catch (e) {
    // Position evtl. schon durch SL/TP am Broker geschlossen — harmlos
    openCount = Math.max(0, openCount - 1);
    console.log(`ℹ️ Close Pos ${positionId} (evtl. schon zu):`, e.message);
  }
}

module.exports = { init, openTrade, moveToBreakeven, modifyStop, closeTrade, status };
