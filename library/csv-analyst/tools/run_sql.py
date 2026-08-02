#!/usr/bin/env python3
"""Run one SELECT over the mounted CSVs.

Every CSV in data/ is loaded into an in-memory SQLite database, one table per
file, and the query runs against that. The database is built per call and thrown
away with the process, so nothing here persists and nothing is written back to
the mounted files — which is what makes a read-only mount the right shape for
this tool.

Columns are typed by sniffing their values, because a CSV read verbatim is all
text and `WHERE units > 100` on text compares "9" as greater than "100".
"""

import csv
import json
import os
import sqlite3
import sys

DATA_DIR = "data"
MAX_ROWS = 200
MAX_CELL = 500


def fail(message):
    json.dump({"error": message, "columns": [], "rows": []}, sys.stdout)
    sys.exit(0)


def table_name(filename):
    stem = os.path.splitext(filename)[0]
    cleaned = "".join(c if c.isalnum() else "_" for c in stem).strip("_").lower()
    return cleaned or "table"


def column_name(raw, index, taken):
    cleaned = "".join(c if c.isalnum() else "_" for c in raw).strip("_").lower()
    if not cleaned or cleaned[0].isdigit():
        cleaned = f"col_{index + 1}"
    candidate = cleaned
    suffix = 2
    while candidate in taken:
        candidate = f"{cleaned}_{suffix}"
        suffix += 1
    return candidate


def sniff(values):
    """INTEGER, REAL or TEXT, decided by every value in the column."""
    seen = False
    integral = True
    for value in values:
        if value == "":
            continue
        seen = True
        try:
            int(value)
        except ValueError:
            integral = False
            try:
                float(value)
            except ValueError:
                return "TEXT"
    if not seen:
        return "TEXT"
    return "INTEGER" if integral else "REAL"


def convert(value, declared):
    if value == "":
        return None
    if declared == "INTEGER":
        return int(value)
    if declared == "REAL":
        return float(value)
    return value


def load(connection, path, filename):
    with open(path, newline="", encoding="utf-8-sig") as handle:
        rows = list(csv.reader(handle))

    if not rows:
        return None

    header, body = rows[0], rows[1:]

    taken = []
    for index, raw in enumerate(header):
        taken.append(column_name(raw, index, taken))

    types = [
        sniff([row[i] for row in body if i < len(row)]) for i in range(len(taken))
    ]

    name = table_name(filename)
    columns = ", ".join(f'"{c}" {t}' for c, t in zip(taken, types))
    connection.execute(f'CREATE TABLE "{name}" ({columns})')

    placeholders = ", ".join("?" * len(taken))
    padded = []
    for row in body:
        cells = (row + [""] * len(taken))[: len(taken)]
        padded.append([convert(cell, types[i]) for i, cell in enumerate(cells)])

    connection.executemany(f'INSERT INTO "{name}" VALUES ({placeholders})', padded)
    return name


def main():
    try:
        args = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError) as exc:
        fail(f"could not parse input JSON: {exc}")

    sql = str(args.get("sql") or "").strip().rstrip(";").strip()
    if not sql:
        fail("no sql was given")

    # One read-only statement. Not a security boundary — the database is built
    # in memory for this call and discarded with the process, so an UPDATE would
    # change nothing anyone can see. It is refused because a model that reaches
    # for one has misunderstood the tool, and saying so is more use than letting
    # it succeed at nothing.
    if ";" in sql:
        fail("run one statement at a time; the query contained a ';'")
    if sql.split(None, 1)[0].upper() not in ("SELECT", "WITH"):
        fail("only SELECT (or WITH ... SELECT) queries are supported")

    if not os.path.isdir(DATA_DIR):
        fail(
            f"no {DATA_DIR}/ directory in this workspace — mount one with "
            f'--mount "./yours.csv:{DATA_DIR}/yours.csv"'
        )

    connection = sqlite3.connect(":memory:")
    loaded = []
    for filename in sorted(os.listdir(DATA_DIR)):
        if not filename.lower().endswith(".csv"):
            continue
        path = os.path.join(DATA_DIR, filename)
        if not os.path.isfile(path):
            continue
        try:
            name = load(connection, path, filename)
        except (OSError, UnicodeDecodeError, csv.Error, sqlite3.Error) as exc:
            fail(f"could not load {filename}: {exc}")
        if name:
            loaded.append(name)

    if not loaded:
        fail(f"{DATA_DIR}/ has no .csv files in it")

    try:
        cursor = connection.execute(sql)
    except sqlite3.Error as exc:
        fail(f"{exc}. Tables available: {', '.join(loaded)}")

    columns = [d[0] for d in cursor.description] if cursor.description else []
    rows = []
    for row in cursor.fetchmany(MAX_ROWS):
        rows.append(
            [
                cell[:MAX_CELL] if isinstance(cell, str) else cell
                for cell in row
            ]
        )

    truncated = cursor.fetchone() is not None

    json.dump(
        {
            "columns": columns,
            "rows": rows,
            "row_count": len(rows),
            "truncated": truncated,
            "tables": loaded,
        },
        sys.stdout,
    )


if __name__ == "__main__":
    main()
