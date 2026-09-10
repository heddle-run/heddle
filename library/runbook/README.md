# runbook

Works an alert against the written runbook, and takes the first remediation step
only once a person has said yes.

```bash
heddle run runbook --session incident-4471 \
  --input '{"alert":"checkout-api 502 rate 12%","service":"checkout-api","environment":"production"}'
```

## What the agent does

It reads the runbook before it reads the metrics — a runbook's steps include
what *not* to do, and that is the expensive part to rediscover at 2am. It checks
the upstreams before touching the service that is complaining, because a service
that times out is usually healthy and waiting on one that is not. It treats a
failure within half an hour of a deploy as that deploy until proved otherwise.

Then it stops, and reports one of two endings:

```
start ──> diagnose ──> route ──┬─> end_resolved   (it acted, one step)
                               └─> end_paged      (it did not, and says why)
```

Anything the router cannot read routes to `end_paged`. A router that guesses
"resolved" is a router that closes incidents.

Doing nothing loudly is a good outcome here, and the agent reaches it on the
sample incident: checkout-api is failing because payments-gw is saturated, and
the runbook forbids both of the levers it has.

## What the operator does

None of the three policy components is named in the spec. They are installed by
whoever runs heddle, and configured on the command line:

```bash
heddle run runbook \
  --plugin-config ChangeApproval='{"tools":["restart_service","scale_service"]}' \
  --protocol audit --session incident-4471 \
  --input '…' > incident.jsonl
```

| Component | Kind | What it does |
| --- | --- | --- |
| `ChangeApproval` | middleware, `toolCall.before` | Suspends the run before a call that changes production. `auto_approve.environments` pre-authorises a blast radius, so the gate asks about the things that matter. |
| `AuditTrail` | middleware, `node.after` + `toolCall` | Records what ran and what was called with what. Not the results: an audit log holding every byte a tool returned is a second copy of production data in a file nobody is guarding. |
| `AuditLog` | encoder, `--protocol audit` | Renders the run as one JSON object per line. Redirect stdout and the incident has a file. |

That split is the point of the entry. The author of the flow chose what the
agent can reach; the operator chooses what it may do unsupervised and what is
written down. A stricter team gets the same bundle with different flags.

## The gate, in full

The first run stops:

```
Stopped for a human: "ChangeApproval" is asking.
{
  "tool": "restart_service",
  "arguments": { "service": "checkout-api", "environment": "production",
                 "reason": "two pods failing readiness since b41; upstream healthy" },
  "question": "Approve restart_service in production?",
  "reply": { "approved": "true or false", "note": "why — it goes in the log" }
}
```

The process can exit. The run is in the session, and anything holding the
session id continues it:

```bash
heddle run runbook --session incident-4471 --resume \
  --answer '{"approved":true,"note":"upstream confirmed healthy"}'
```

**What approval does, precisely.** heddle replays your answer as the tool's
result — the tool does not then run. The run prints `"restart_service" was
answered by a human rather than run`, and the agent carries on from your
verdict. So this gate approves the *decision*, and the change is applied by the
person who approved it or by a run where that blast radius is pre-authorised:

```bash
--plugin-config ChangeApproval='{"tools":["restart_service","scale_service"],"auto_approve":{"environments":["staging"]}}'
```

With that, a restart in staging runs for real and one in production still stops.
Sizing the gate is the operator's job, and it is the honest version of "the
agent can act": it acts where you have decided it may.

## Tools

| Tool | Changes production |
| --- | --- |
| `read_runbook` | no |
| `service_health` | no |
| `recent_deploys` | no |
| `log_search` | no |
| `restart_service` | **yes** — gated, and requires a `reason` |
| `scale_service` | **yes** — gated, and requires a `reason` |

The two that act write a line to `changes.jsonl` in the workspace and ask
nobody's permission, on purpose: a tool that negotiates its own permission is a
tool whose permission cannot be changed without editing it.

They read `fixtures/` — an invented incident, so the bundle runs before it is
wired to anything. Point them at your own platform and the flow does not change.

## Over HTTP

The same two steps. A run naming a session answers `202` with the question, and
a second request with `"resume": true` and an `"answer"` object continues it —
so the approval can come from a Slack button rather than a terminal. The audit
encoder is selectable per request with `?protocol=audit`.
