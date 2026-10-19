# Absorptions-Zonen (Orderflow-Näherung)

Zwei Teile, gleiche Logik:

- **`tradingview/apex-absorption.pine`** – Indikator für den Chart (TradingView Essential reicht).
- **`absorption.js`** – dasselbe im Bot, gefüttert aus dem 1M-Webhook.

## Wie es funktioniert

1. Aus 1-Minuten-Kerzen werden 5-Minuten-Kerzen gebaut. Für jede 1M-Kerze wird geschätzt,
   ob eher Käufer oder Verkäufer aggressiv waren (Close-Position in der Kerze) → Delta.
2. **Absorption** = viel Volumen (≥ 1,8 × Schnitt), aber kaum Bewegung (Körper ≤ 0,6 × ATR)
   plus langer Docht oder Delta gegen die Kerze. Daraus wird eine Zone:
   - Verkauf-Absorption → **Widerstand**
   - Kauf-Absorption → **Unterstützung**
3. **Signal**, wenn der Preis eine Zone erneut antestet und abprallt
   (SHORT „Trapped Buyers“ / LONG „Trapped Sellers“). SL hinter der Zone,
   Ziel = nächste Gegen-Zone (mind. 1,5 R), sonst 2 R.

> ⚠️ Auf CFDs (XAUUSD, NAS100) ist das Volumen nur **Tick-Volumen**, kein echtes
> Kauf-/Verkaufsvolumen. Das hier ist eine Näherung – erst beobachten, dann scharf schalten.

## Bot einrichten

### 1. TradingView-Alert erweitern (Pflicht)

Die 1M-Alerts für Gold und Nasdaq brauchen `open`, `volume` und `time`. Nachricht ersetzen durch:

```json
{"symbol":"{{ticker}}","open":{{open}},"high":{{high}},"low":{{low}},"close":{{close}},"volume":{{volume}},"time":"{{time}}"}
```

Ohne `volume` bleibt das Modul automatisch **inaktiv** (steht dann so in `/diag`).
Alte Alerts ohne diese Felder funktionieren weiter wie bisher.

### 2. Modus wählen (Railway-Env `ABSORPTION_MODE`)

| Modus | Wirkung |
|---|---|
| `log` *(Standard)* | Nur beobachten. Zonen + „würde blocken“ in Logs und `/diag`. **Kein Einfluss aufs Trading.** |
| `filter` | Scalp-Signale, die direkt in eine Gegen-Zone laufen, werden geblockt. |
| `signal` | `filter` + eigene Absorptions-Trades (Typ `absorption`, eigene Telegram-Nachricht). |
| `off` | Komplett aus. |

Weitere Env-Variablen: `ABSORPTION_TF` (Default `5` Minuten), `ABSORPTION_INSTANT=true`
(Signal schon an der Absorptions-Kerze selbst, aggressiver).

### 3. Auswerten

`/diag` zeigt im Abschnitt **Absorption**: aktive Zonen, letztes Signal und –
im `log`-Modus – die Trefferquote der Scalp-Trades **in** einer Gegen-Zone vs. **ohne**.
Erst wenn „in Gegen-Zone“ über einige Wochen klar schlechter abschneidet, auf `filter` stellen.
`signal` erst nach eigenem Backtest/Demo.
