# private-reader

Answers questions about a folder of documents that never leave the machine.

```bash
heddle run private-reader --mount ~/Documents/tax-2026:documents:ro \
  --input '{"question":"What did I actually agree to about the deposit?"}'
```

A tenancy agreement, a bank statement, a letter from the tax office, a
diagnosis. The documents you would never paste into a chat window are exactly
the ones worth asking questions of, and three invented ones ship inside the
bundle so it runs before you point it at your own.

## Nothing leaves the building

The spec names no vendor. `OpenAiConfig` with no `url` sets no base URL on the
client, so the OpenAI SDK uses `OPENAI_BASE_URL` — one environment variable,
and the same file runs against a model on this machine:

```bash
OPENAI_BASE_URL=http://localhost:11434/v1 OPENAI_API_KEY=ollama \
  heddle run private-reader --mount ~/Documents:documents:ro \
  --input '{"question":"…"}'
```

That is the whole local-model story. `ollama serve` and `ollama pull qwen3` on
one side, an env var on the other, and the model id in the spec changed to
whatever you pulled. The documents are read by tools running as you, the
question goes to localhost, and there is no request to be intercepted because
there is no request.

Leave `OPENAI_BASE_URL` unset and it runs on gpt-4o-mini instead. Same document,
different machine, different bill.

## The citation is enforced, not requested

The prompt asks the model to cite. Prompts are requests, and a model that cannot
find the answer will still write a fluent one — that failure is the reason most
people do not trust an agent with a contract.

So `plugin.mjs` contributes a `post` transform. An answer with no `file.ext:line`
in it is rejected on its way out, the agent records `transform_status:
"rejected"`, and the flow takes the other ending:

```
start ──> read ──> route ──┬─> end_answered    (cited)
                           └─> end_ungrounded  (refused, with the reason)
```

You can watch it happen. This asks a real question and gives the model an answer
that sounds right and cites nothing:

```bash
node .claude/skills/create-heddle-agent/driver.mjs run library/private-reader/spec.yaml \
  --tools-dir library/private-reader/tools \
  --plugin ./library/private-reader/plugin.mjs \
  --args library/private-reader/probe-args.json \
  --final 'Yes, a month of notice is usually fine and there is no penalty.' \
  --input '{"question":"When can I give notice on the flat?"}'
```

The run ends at `end_ungrounded` with `the answer cites 0 passage(s) where 1 is
required`. Raise the bar with `min_citations` on the `CitationCheck` component
in the spec.

## Tools

| Tool | What it does |
| --- | --- |
| `doc_list` | Every document with its length. Names carry information — a date, a counterparty, a kind of document. |
| `doc_search` | Phrase search across the folder, tolerant of line wraps. Returns `file.ext:line text` — the citation form the answer must use. |
| `doc_excerpt` | A numbered window around a line, so a citation taken from it is right without counting. |

Plain text only: `.md`, `.txt`, `.csv`, `.json`, `.eml`, `.rtf`. A PDF in the
folder is listed and named as unreadable rather than silently skipped — convert
it first (`pdftotext -layout`) and it joins the rest.

## What it will not do

It reads; it does not act, and it cannot write to the folder — the mount is
`:ro`. It answers from the documents and refuses to answer from general
knowledge, which means a question the folder does not cover gets a refusal
rather than a plausible paragraph. And with a hosted model the documents do
leave the machine, in the excerpts the tools return. If that is the thing you
were avoiding, set `OPENAI_BASE_URL`.
