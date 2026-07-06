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

// Öffnet eine Market-Position mit SL und TP. Gibt die positionId zurück (oder null).
//   sessionKey: 'XAUUSD' | 'NDX'   signal: 'BUY' | 'SELL'
//   entry (nur Log), sl, tp: absolute Preise    tag: z.B. 'XAUUSD_SWING'
async function openTrade({ sessionKey, signal, entry, sl, tp, type, tag }) {
  const symbol = SYMBOL_MAP[sessionKey];
  const volume = LOT_MAP[sessionKey];
  const label = `${signal} ${symbol} @${entry} SL ${sl} TP ${tp} (${type}, ${volume} Lot)`;

  if (!EXECUTE) { console.log(`🧪 [DRY-RUN] würde öffnen: ${label}`); return `DRY-${Date.now()}`; }
  if (!ready)   { console.warn(`⚠️ Broker nicht bereit — ${label} NICHT ausgeführt`); return null; }
  if (openCount >= MAX_OPEN) { console.warn(`⚠️ MAX_OPEN_BROKER (${MAX_OPEN}) erreicht — ${label} übersprungen`); return null; }

  try {
    const opts = { comment: 'ApexBot', clientId: (tag || sessionKey).slice(0, 24) + '_' + Date.now() };
    const res = signal === 'BUY'
      ? await connection.createMarketBuyOrder(symbol, volume, sl, tp, opts)
      : await connection.createMarketSellOrder(symbol, volume, sl, tp, opts);
    if (ok(res) && res.positionId) {
      openCount++;
      console.log(`📈 Broker OPEN: ${label} → Position ${res.positionId}`);
      return res.positionId;
    }
    console.error(`❌ Broker-Order abgelehnt: ${res && (res.stringCode || res.description || res.message)} — ${label}`);
    return null;
  } catch (e) {
    console.error(`❌ Broker openTrade Fehler (${label}):`, e.message);
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

module.exports = { init, openTrade, moveToBreakeven, closeTrade, status };
