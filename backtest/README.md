# Absorption-Backtest

Testet die Absorptions-Logik des Bots (`absorption.js`, 1:1 dieselbe) auf historischen Daten
**bevor** du für Live-Orderflow zahlst. Vergleicht drei Dinge:

1. **Geschätzt**: so, wie der Bot es heute aus Kerzen schätzt
2. **Echt**: mit echtem Kauf-/Verkaufsvolumen von der CME (Databento)
3. **Zufall**: gleiche Anzahl Trades, gleicher SL/TP-Abstand, aber zufälliger Einstieg (Gegenprobe)

Nur wenn „Echt“ nach Kosten im Plus ist **und** klar besser als „Zufall“, lohnt sich das Live-Abo.

---

## Schnellstart (MacBook, Terminal)

```bash
# 1. Code holen (Branch mit dem Absorptions-Modul)
git clone https://github.com/22z2p6fgpm-sys/Apex-Signal-Bot-.git
cd Apex-Signal-Bot-
git checkout feature/absorption-zones

# 2. Python-Pakete (in einer eigenen Umgebung, damit macOS nicht meckert)
python3 -m venv .venv && source .venv/bin/activate
pip install -r backtest/requirements.txt

# 3. Databento-API-Key (databento.com → Konto anlegen → API Keys)
export DATABENTO_API_KEY="db-…"

# 4. Kosten prüfen – kostet nichts
python3 backtest/fetch_databento.py --symbol NQ --start 2026-09-01 --end 2026-10-01 --check-cost

# 5. Laden (fragt vor dem Bezahlen nach; bricht über 25 $ automatisch ab)
python3 backtest/fetch_databento.py --symbol NQ --start 2026-09-01 --end 2026-10-01

# 6. Backtest (braucht Node 18+, sonst vorher von nodejs.org installieren)
node backtest/backtest.js backtest/data/NQ_1m.csv --pv 20
```

Bei einem neuen Terminal-Fenster vorher wieder `source .venv/bin/activate` und den Key exportieren.

Ergebnis: Tabelle im Terminal plus `backtest/out/summary.json` und `trades_*.csv`.
Schick mir einfach die Terminal-Ausgabe oder `summary.json`.

**Tipps**
- Mit **1 Monat** anfangen, um die echten Kosten zu sehen. Dann erweitern: das Skript lädt
  nur fehlende Tage nach (`--end` einfach später setzen).
- Gold: `--symbol MGC` (oder `GC`) und beim Backtest `--pv 10` (MGC) bzw. `--pv 100` (GC).
- Nasdaq Micro: Daten von `NQ` laden (mehr Volumen, gleicher Kurs), Backtest mit `--pv 2` = MNQ-Dollar.

## Kostenlos vorab: TradingView-Export (nur Schätzung)

Falls dein TradingView-Plan „Chartdaten exportieren“ hat: `MNQ1!` oder `NQ1!` im 1-Minuten-Chart öffnen,
so weit wie möglich zurückscrollen, Export als CSV. Dann:

```bash
node backtest/backtest.js export.csv --pv 2
```

Das testet nur die **Schätzung** (keine echten Kauf-/Verkaufsdaten) und meist nur wenige Tage.

## Optionen

| Option | Bedeutung | Standard |
|---|---|---|
| `--pv` | $ pro Punkt & Kontrakt (NQ 20 · MNQ 2 · GC 100 · MGC 10) | 20 |
| `--cost` | Kosten pro Trade hin+zurück in Punkten (Slippage + Gebühr) | 0.75 |
| `--session` | `all`, `ny` (09:30–11:30 New York), `nyday` (09:30–16:00) | all |
| `--tf` | Analyse-Zeiteinheit in Minuten | 5 |
| `--timeout` | Trade nach X Minuten schließen | 240 |
| `--instant` | Auch Sofort-Signale an der Absorptions-Kerze | aus |
| `--vol-mult`, `--effort`, `--min-rr` | Absorptions-Parameter | 1.8 / 0.6 / 1.5 |
| `--from`, `--to` | Zeitraum eingrenzen (YYYY-MM-DD) | alles |

## Wie simuliert wird (bewusst vorsichtig)

- Einstieg zum Schlusskurs der Signal-Kerze, nur **eine** Position gleichzeitig (wie im Bot).
- Berühren SL und TP dieselbe Minute → zählt als **Verlust**.
- Kurslücke über den SL → Ausstieg zum schlechteren Eröffnungskurs.
- Kosten werden von jedem Trade abgezogen.
- Fester SL/TP, kein Break-even/Trailing. Das ist eine reine Prüfung der Signal-Qualität.

## Ergebnis richtig lesen

- **Unter 100 Trades** ist alles Zufall-anfällig, dann längeren Zeitraum laden.
- **Nicht an den Parametern drehen, bis es passt.** Das ist Überanpassung. Wenn du etwas änderst,
  das Ergebnis danach auf einem **anderen** Zeitraum gegenprüfen.
- Der Check beim Download (Korrelation Delta ↔ Kursbewegung) muss **positiv** sein,
  sonst stimmt etwas mit den Daten nicht.
