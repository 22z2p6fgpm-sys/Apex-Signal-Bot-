#!/usr/bin/env python3
"""
Echter Orderflow für den Backtest: lädt CME-Trades von Databento (jeder einzelne
Trade inkl. Aggressor-Seite) und verdichtet sie zu 1-Minuten-Kerzen mit ECHTEM
Kauf- und Verkaufsvolumen. Ergebnis: CSV für backtest.js.

  1) Kosten prüfen (kostet nichts):
       python3 fetch_databento.py --symbol NQ --start 2026-07-01 --end 2026-10-01 --check-cost
  2) Laden (fragt vorher nach, bricht über --max-cost ab):
       python3 fetch_databento.py --symbol NQ --start 2026-07-01 --end 2026-10-01

API-Key: Umgebungsvariable DATABENTO_API_KEY (oder --key).
Lädt tageweise und setzt nach einem Abbruch beim letzten Tag fort (nichts doppelt bezahlen).
"""
import argparse
import os
import sys
from datetime import date, datetime, timedelta, timezone

DATASET = "GLBX.MDP3"  # CME Globex


def parse_args():
    p = argparse.ArgumentParser(description="Databento CME-Trades → 1M-Kerzen mit echtem Delta")
    p.add_argument("--symbol", default="NQ", help="Futures-Wurzel: NQ, MNQ, ES, GC, MGC … (Default NQ)")
    p.add_argument("--start", required=True, help="Startdatum YYYY-MM-DD (UTC)")
    p.add_argument("--end", required=True, help="Enddatum YYYY-MM-DD (UTC, exklusiv)")
    p.add_argument("--roll", default="v", choices=["v", "c", "n"],
                   help="Kontrakt-Wechsel: v=meistgehandelt (Default), c=Kalender, n=Open Interest")
    p.add_argument("--out", default=None, help="Ziel-CSV (Default data/<SYMBOL>_1m.csv)")
    p.add_argument("--check-cost", action="store_true", help="nur Kosten anzeigen, nichts laden")
    p.add_argument("--max-cost", type=float, default=25.0, help="Abbruch, wenn teurer als X USD (Default 25)")
    p.add_argument("--yes", action="store_true", help="ohne Rückfrage laden")
    p.add_argument("--key", default=None, help="API-Key (sonst DATABENTO_API_KEY)")
    return p.parse_args()


# ─── Trades → 1-Minuten-Kerzen ──────────────────────────────────────────────
def trades_to_minutes(df):
    """df: Databento-Trades als DataFrame (Spalten price, size, side; Zeit in ts_event oder Index).
    side = Aggressor: 'B' = Käufer hat den Ask genommen, 'A' = Verkäufer hat den Bid genommen."""
    import pandas as pd

    if df is None or len(df) == 0:
        return pd.DataFrame(columns=["time", "open", "high", "low", "close", "volume", "buy", "sell", "delta"])
    d = df.copy()
    if "action" in d.columns:
        d = d[d["action"].astype(str).isin(["T", "Action.TRADE", "TRADE"]) | (d["action"].astype(str).str.len() == 0)]
    ts = pd.to_datetime(d["ts_event"], utc=True) if "ts_event" in d.columns else pd.to_datetime(d.index, utc=True)
    side = d["side"].astype(str).str.upper().str.replace("SIDE.", "", regex=False)
    is_buy = side.isin(["B", "BID"])    # Aggressor kauft (nimmt den Ask)
    is_sell = side.isin(["A", "ASK"])   # Aggressor verkauft (trifft den Bid)
    size = d["size"].astype("int64")
    frame = pd.DataFrame({
        "minute": ts.dt.floor("1min") if hasattr(ts, "dt") else ts.floor("1min"),
        "price": d["price"].astype(float).values,
        "size": size.values,
        "buy": size.where(is_buy, 0).values,
        "sell": size.where(is_sell, 0).values,
    })
    frame = frame.sort_values("minute", kind="stable")
    g = frame.groupby("minute", sort=True)
    out = pd.DataFrame({
        "open": g["price"].first(),
        "high": g["price"].max(),
        "low": g["price"].min(),
        "close": g["price"].last(),
        "volume": g["size"].sum(),
        "buy": g["buy"].sum(),
        "sell": g["sell"].sum(),
    })
    out["delta"] = out["buy"] - out["sell"]
    out = out.reset_index().rename(columns={"minute": "time"})
    out["time"] = out["time"].dt.strftime("%Y-%m-%dT%H:%M:00Z")
    return out[["time", "open", "high", "low", "close", "volume", "buy", "sell", "delta"]]


def sanity_check(path):
    """Plausibilität: Minuten mit Kauf-Überhang sollten im Schnitt steigen."""
    import pandas as pd
    df = pd.read_csv(path)
    if len(df) < 100:
        print(f"ℹ️  Nur {len(df)} Minuten – zu wenig für einen Plausibilitäts-Check.")
        return
    move = df["close"] - df["open"]
    corr = df["delta"].corr(move)
    covered = (df["buy"] + df["sell"]).sum() / max(1, df["volume"].sum())
    print(f"🔎 Check: Korrelation Delta ↔ Kursbewegung je Minute = {corr:+.2f} (erwartet deutlich > 0)")
    print(f"🔎 Check: Anteil Volumen mit bekannter Aggressor-Seite = {covered:.0%}")
    if corr < 0:
        print("⚠️  Negative Korrelation – Kauf/Verkauf scheinen vertauscht. Bitte melden, nicht weiter nutzen.")


def last_time_in(path):
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            pos = f.tell()
            if pos == 0:
                return None
            back = min(pos, 4096)
            f.seek(-back, os.SEEK_END)
            lines = f.read().decode().strip().splitlines()
        last = lines[-1].split(",")[0]
        if last == "time":
            return None
        return datetime.strptime(last, "%Y-%m-%dT%H:%M:00Z").replace(tzinfo=timezone.utc)
    except (OSError, ValueError, IndexError):
        return None


def main():
    a = parse_args()
    key = a.key or os.environ.get("DATABENTO_API_KEY")
    if not key:
        sys.exit("❌ Kein API-Key. Setze DATABENTO_API_KEY oder nutze --key.")
    try:
        import databento as db
    except ImportError:
        sys.exit("❌ Paket fehlt: pip3 install databento pandas")

    sym = f"{a.symbol.upper()}.{a.roll}.0"
    start = date.fromisoformat(a.start)
    end = date.fromisoformat(a.end)
    if end <= start:
        sys.exit("❌ --end muss nach --start liegen.")
    out = a.out or os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", f"{a.symbol.upper()}_1m.csv")
    os.makedirs(os.path.dirname(out), exist_ok=True)

    client = db.Historical(key)

    # Fortsetzen nach Abbruch
    resume_from = last_time_in(out) if os.path.exists(out) else None
    first_day = start
    if resume_from is not None:
        # Es werden immer nur komplette Tage geschrieben → ab dem Folgetag weiter (nichts doppelt bezahlen)
        first_day = max(start, resume_from.date() + timedelta(days=1))
        print(f"↩️  {out} existiert bis {resume_from:%Y-%m-%d %H:%M} UTC – setze ab {first_day} fort.")
    if first_day >= end:
        print("✅ Zeitraum ist schon komplett geladen.")
        sanity_check(out)
        return

    cost = client.metadata.get_cost(dataset=DATASET, symbols=[sym], stype_in="continuous",
                                    schema="trades", start=first_day.isoformat(), end=end.isoformat())
    size = client.metadata.get_billable_size(dataset=DATASET, symbols=[sym], stype_in="continuous",
                                             schema="trades", start=first_day.isoformat(), end=end.isoformat())
    print(f"💰 {sym} Trades {first_day} → {end}: {size / 1e9:.2f} GB · Kosten laut Databento: {cost:.2f} USD")
    if a.check_cost:
        return
    if cost > a.max_cost:
        sys.exit(f"❌ Teurer als --max-cost {a.max_cost:.2f} USD – Zeitraum verkürzen oder Limit erhöhen.")
    if not a.yes:
        ans = input("Laden? Das wird von deinem Databento-Guthaben/Konto abgerechnet. (j/n) ").strip().lower()
        if ans not in ("j", "ja", "y", "yes"):
            print("Abgebrochen – nichts geladen.")
            return

    write_header = not os.path.exists(out) or os.path.getsize(out) == 0
    day = first_day
    total_rows = 0
    while day < end:
        nxt = day + timedelta(days=1)
        if day.weekday() == 5:  # Samstag: CME geschlossen
            day = nxt
            continue
        try:
            store = client.timeseries.get_range(dataset=DATASET, symbols=[sym], stype_in="continuous",
                                                schema="trades", start=day.isoformat(), end=nxt.isoformat())
            bars = trades_to_minutes(store.to_df())
        except Exception as e:  # einzelner Tag fehlgeschlagen → weiter, später neu starten setzt hier fort
            print(f"⚠️  {day}: {e} – Tag übersprungen (später mit --start {day} --end {nxt} nachladen)")
            day = nxt
            continue
        if resume_from is not None and len(bars):
            bars = bars[bars["time"] > resume_from.strftime("%Y-%m-%dT%H:%M:00Z")]
        if len(bars):
            bars.to_csv(out, mode="a", header=write_header, index=False)
            write_header = False
            total_rows += len(bars)
        print(f"📥 {day}: {len(bars)} Minuten")
        day = nxt

    print(f"✅ Fertig: {total_rows} neue Minuten → {out}")
    sanity_check(out)


if __name__ == "__main__":
    main()
