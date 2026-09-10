# quick-capture

Throw it any lump of text and it decides what to do with it: a reminder, a note,
or nothing.

```bash
heddle run quick-capture --input '{"text":"parking permit expires 30 Sep","source":"share sheet","now":"2026-09-10"}'
```

```json
{"action":"reminder","title":"Renew the parking permit","due":"2026-09-30",
 "summary":"Reminder for 30 Sep — the permit expires and renewal takes 5 days"}
```

## No tools, on purpose

This is the only entry in the library that ships no tools and no mounts, and
that is a design decision. A bundle carrying an executable cannot run inside the
phone's own JavaScript engine — `checkPortability` refuses it — so it would
reach for a server on every run. This one runs **on the device**, with the model
key in the Keychain and nothing else.

So the division of labour is: **the agent decides, the Shortcut acts.** Which is
also how a Shortcut wants to work — it already knows how to add a reminder.

## The three surfaces

**iOS, from a Shortcut.** Import the bundle into Heddle for iOS, then build a
shortcut with three actions:

1. **Run Agent** — pick `quick-capture`, pass the Shortcut Input as the text.
2. **Get Dictionary Value** — `action` from the agent's answer.
3. **If** `action` is `reminder` → *Add Reminder* with `title` and `due`;
   if `note` → *Append to Note*; otherwise stop.

Add it to the share sheet and it is one tap from any app. Nothing suspends, so
nothing can stop and wait for an answer nobody is there to give — an agent that
asks a question cannot run from a Shortcut, and this one never asks.

**macOS, from the menu bar.** The app exposes a URL scheme:

```bash
open "heddle://run?agent=Quick%20Capture&input=%7B%22text%22%3A%22…%22%7D"
```

Bind that to a hotkey in Raycast or Shortcuts with the clipboard as the text,
and capture is one keystroke.

**Anywhere, from a pipe.** The answer is JSON on stdout, so a shell can act on
it:

```bash
pbpaste | jq -Rs '{text:., source:"clipboard", now:(now|strftime("%Y-%m-%d"))}' \
  | heddle run quick-capture --input "$(cat)" | jq -r .summary
```

## The shape is a contract

An automation reads one field and acts. A model that decides today to wrap its
JSON in a friendly sentence has broken the shortcut, and it breaks quietly: the
reminder simply never appears.

So `plugin.mjs` contributes a `post` transform that checks the shape rather than
hoping for it — the action is one of three, a reminder has a title, the summary
exists and fits on one line. An answer that fails is rejected and the flow ends
at `end_unclear` with the reason:

```
start ──> decide ──> route_shape ──┬─> end_unclear   (unusable answer)
                                   └─> route_action ──┬─> end_ignored   (noise)
                                                      └─> end_captured
```

Two branches in a row rather than one clever one: the first asks whether the
answer is usable at all, and only then is it worth asking what it says.

Watch it refuse:

```bash
node .claude/skills/create-heddle-agent/driver.mjs run library/quick-capture/spec.yaml \
  --plugin ./library/quick-capture/plugin.mjs \
  --final 'Sure! I have created a reminder for you.' \
  --input '{"text":"pay the gas bill friday","source":"voice memo","now":"2026-09-10"}'
```

## Choosing nothing

A capture tool that files everything is a capture tool people stop trusting, so
`nothing` is a first-class answer with its own ending. Cookie banners,
navigation menus, three words of a conversation — the flow reaches `end_ignored`
and the Shortcut shows the summary and stops.

The same instinct governs dates. `now` is passed in because the model cannot
know it, "next Friday" is resolved against it, and text with no moment in it
becomes a note: a reminder with an invented date is worse than a note.
