# helpdesk

First-line IT support that answers from the handbook packed inside it.

```bash
heddle run helpdesk --input '{"question":"VPN says connected but nothing loads","asked_by":"Sam"}'
```

The point of this one is who can run it. There is no wiki to reach, no VPN to be
on and no repository to clone: the handbook is a mounted directory inside the
`.heddle` file, so a colleague with the file and a model key has the whole
agent. Send it in Slack.

## What it does

It searches the handbook the way a person would — more than once, with different
words — reads the whole procedure rather than the line that matched, and answers
in its own words, naming the document it came from.

The interesting half is what happens when the handbook is silent. It does not
improvise a plausible-sounding process for a company it knows nothing about. It
drafts a ticket into the workspace — what was asked, what it checked, who is
asking — and the flow takes a different ending that says so:

```
start ──> answer ──> route ──┬─> end_answered
                             └─> end_escalated
```

The branch reads `resolution` off the agent's own answer, which is why the
prompt insists on a JSON object rather than prose.

## Make it yours

Two edits, in this order:

1. **Replace `handbook/`** with your own markdown. Any number of files, any
   headings; the search tool reports the heading a match sits under and
   `handbook_read` fetches a section by name, so write it the way you would
   write it for a person.
2. **Replace `tools/ticket_draft.sh`** if you have a ticketing system. It writes
   a markdown file into the workspace today, which is the version that works on
   a laptop with no credentials. A script that POSTs to Jira and prints
   `{"ticket_id": …}` drops straight in — nothing else about the agent changes.

Then pack it and send it:

```bash
node library/build.mjs helpdesk
heddle run library/dist/helpdesk.heddle --input '{"question":"…","asked_by":"…"}'
```

Or, while you are still editing it, run the source:

```bash
heddle run library/helpdesk/spec.yaml \
  --tools-dir library/helpdesk/tools \
  --mount library/helpdesk/handbook:handbook:ro \
  --input '{"question":"How do I get a production read-only login?","asked_by":"Sam"}'
```

## Tools

| Tool | What it does |
| --- | --- |
| `handbook_search` | Whole-word search across the handbook. Returns `document:line [heading] text`, so the model can follow up precisely. |
| `handbook_read` | One document, or one section of it by heading. A search hit is rarely the whole procedure. |
| `ticket_draft` | Writes `tickets/IT-<stamp>-<slug>.md` into the workspace and returns the id. |

Each finds the handbook in the workspace mount first and falls back to a sibling
of `tools/`, so the same script works from a bundle and from this checkout.

## What it will not do

It answers from the handbook and nothing else, so a handbook that is wrong makes
it confidently wrong — it is a reader, not a source. It has no memory of your
systems between runs unless you run it with `--session`. And it cannot act: the
worst it can do to your machine is write a markdown file into the workspace.
