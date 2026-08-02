#!/usr/bin/env python3
"""What tables the mounted data directory turned into, and what is in them.

The first call an agent should make: it cannot write a useful query against
column names it guessed. Deliberately does not open sqlite — reading the header
row and counting lines is enough to describe a CSV, and a tool that answers a
cheap question cheaply is one the model can afford to call first.
"""

import csv
import json
import os
import sys

DATA_DIR = "data"
SAMPLE_ROWS = 3
MAX_CELL = 120


def fail(message):
    json.dump({"error": message, "tables": []}, sys.stdout)
    sys.exit(0)


def table_name(filename):
    """A CSV's file name, as something SQL can address."""
    stem = os.path.splitext(filename)[0]
    cleaned = "".join(c if c.isalnum() else "_" for c in stem).strip("_").lower()
    return cleaned or "table"


def describe(path, filename):
    with open(path, newline="", encoding="utf-8-sig") as handle:
        reader = csv.reader(handle)
        try:
            header = next(reader)
        except StopIteration:
            return {
                "table": table_name(filename),
                "file": filename,
                "columns": [],
                "rows": 0,
                "sample": [],
            }

        sample = []
        rows = 0
        for row in reader:
            rows += 1
            if len(sample) < SAMPLE_ROWS:
                sample.append([cell[:MAX_CELL] for cell in row])

    return {
        "table": table_name(filename),
        "file": filename,
        "columns": header,
        "rows": rows,
        "sample": sample,
    }


def main():
    try:
        json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError) as exc:
        fail(f"could not parse input JSON: {exc}")

    if not os.path.isdir(DATA_DIR):
        fail(
            f"no {DATA_DIR}/ directory in this workspace — mount one with "
            f'--mount "./yours.csv:{DATA_DIR}/yours.csv"'
        )

    tables = []
    for filename in sorted(os.listdir(DATA_DIR)):
        if not filename.lower().endswith(".csv"):
            continue
        path = os.path.join(DATA_DIR, filename)
        if not os.path.isfile(path):
            continue
        try:
            tables.append(describe(path, filename))
        except (OSError, UnicodeDecodeError, csv.Error) as exc:
            tables.append({"file": filename, "error": str(exc)})

    if not tables:
        fail(f"{DATA_DIR}/ has no .csv files in it")

    json.dump({"count": len(tables), "tables": tables}, sys.stdout)


if __name__ == "__main__":
    main()
