# csv-analyst

Answers questions about a folder of CSVs by writing SQL against them.

```
start ──> analyst (Agent + describe_data + run_sql) ──> end
```

Every CSV mounted at `data/` is loaded into an in-memory SQLite database, one
table per file, and the agent writes a `SELECT` to answer the question. So joins
across files work, and the arithmetic is done by a database rather than by a
language model reading numbers out of a prompt.

## Run it

```bash
node library/build.mjs csv-analyst
heddle run library/dist/csv-analyst.heddle
```

The bundle carries a sample `orders.csv` and `products.csv`, so it answers with
no setup.

## Point it at your own data

A repeatable flag composes with what the bundle carries, so your file becomes
another table beside the samples:

```bash
heddle run library/dist/csv-analyst.heddle \
  --mount ./sales.csv:data/sales.csv \
  --input '{"question":"which month had the most refunds?"}'
```

To query only your own, run the spec rather than the bundle:

```bash
heddle run library/csv-analyst/spec.yaml \
  --tools-dir library/csv-analyst/tools \
  --mount ./sales.csv:data/sales.csv \
  --input '{"question":"..."}'
```

## The tools

| Tool | |
|---|---|
| `describe_data` | Tables, columns, row counts and a few sample rows. The agent is told to call it first, every time, because it cannot write a correct query against column names it guessed — and the files change between runs. |
| `run_sql` | One `SELECT` (or `WITH … SELECT`), up to 200 rows. SQLite dialect. An error names the tables that do exist, so a wrong guess is recoverable in one more call. |

**Column types are sniffed, not assumed.** A CSV read verbatim is all text, and
`WHERE units > 100` on text puts `"9"` above `"100"`. Each column is typed
`INTEGER`, `REAL` or `TEXT` by looking at every value in it, so comparisons and
`SUM` do what you expect. A file name becomes a table name: `orders.csv` is
`orders`, and anything that is not alphanumeric becomes an underscore.

The database is built per call and discarded with the process. Nothing is
written back to your files — `run_sql` refuses anything but a read, not as a
security boundary but because a model reaching for `UPDATE` has misunderstood
the tool, and saying so is more use than letting it succeed at nothing.

## What it will not do

Every figure in the answer has to come from a row `run_sql` returned, and the
SQL it ran is printed with the answer so you can check it. Where the data cannot
answer the question it says what is missing rather than estimating.

## Requires

`OPENAI_API_KEY` and `python3` (standard library only — `csv` and `sqlite3`).
The tools read `data/` inside the workspace and nothing else, so `--safe` needs
no extra grants:

```bash
heddle run library/dist/csv-analyst.heddle --safe
```
