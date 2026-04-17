import argparse
import os
import time

import pandas as pd
import yfinance as yf


DEFAULT_TICKERS = [
    "BTC-USD",
    "ETH-USD",
    "SOL-USD",
    "AVAX-USD",
    "LINK-USD",
    "DOGE-USD",
    "SPY",
    "QQQ",
    "SQQQ",
    "BITI",
    "XLE",
    "GLD",
    "TLT",
    "^VIX",
    "CL=F",
]


def normalize_interval(value: str) -> str:
    normalized = str(value or "1h").strip().lower()
    aliases = {
        "1hour": "1h",
        "hourly": "1h",
        "1hr": "1h",
        "1day": "1d",
        "daily": "1d",
    }
    return aliases.get(normalized, normalized)


def pull_data(tickers, period="6mo", interval="1h", output_dir="workspace/data/backtest", pause_seconds=1.0):
    if not os.path.exists(output_dir):
        os.makedirs(output_dir)
        print(f"Created output directory: {output_dir}")

    print(f"Starting data pull for {len(tickers)} tickers. Period: {period}, Interval: {interval}")

    for ticker in tickers:
        print(f"Fetching data for {ticker}...")
        try:
            df = yf.download(ticker, period=period, interval=interval, progress=False)

            if df.empty:
                print(f"  Warning: No data returned for {ticker}. It might be delisted or the ticker symbol is wrong.")
                continue

            if isinstance(df.columns, pd.MultiIndex):
                df.columns = df.columns.droplevel(1)

            df.reset_index(inplace=True)
            if "Datetime" in df.columns:
                df.rename(columns={"Datetime": "timestamp"}, inplace=True)
            elif "Date" in df.columns:
                df.rename(columns={"Date": "timestamp"}, inplace=True)

            df = df[["timestamp", "Open", "High", "Low", "Close", "Volume"]]

            filename = f"{ticker.replace('-', '_')}_{interval}_{period}.csv"
            filepath = os.path.join(output_dir, filename)
            df.to_csv(filepath, index=False)
            print(f"  Success: Saved {len(df)} rows to {filepath}")

            time.sleep(max(0, float(pause_seconds)))
        except Exception as exc:
            print(f"  Error fetching {ticker}: {exc}")


def parse_args():
    parser = argparse.ArgumentParser(description="Pull backtest OHLCV data from Yahoo Finance.")
    parser.add_argument("--tickers", default=",".join(DEFAULT_TICKERS), help="Comma-separated Yahoo tickers")
    parser.add_argument("--period", default="6mo", help="Yahoo period, e.g. 6mo, 730d, 5y")
    parser.add_argument("--interval", default="1h", help="Yahoo interval, e.g. 1h, 1d")
    parser.add_argument("--output-dir", default="workspace/data/backtest", help="Directory to write CSV files")
    parser.add_argument("--pause-seconds", type=float, default=1.0, help="Sleep between ticker pulls")
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    tickers = [ticker.strip() for ticker in args.tickers.split(",") if ticker.strip()]
    interval = normalize_interval(args.interval)
    pull_data(
        tickers=tickers,
        period=args.period,
        interval=interval,
        output_dir=args.output_dir,
        pause_seconds=args.pause_seconds,
    )
    print("\nData pull complete.")
