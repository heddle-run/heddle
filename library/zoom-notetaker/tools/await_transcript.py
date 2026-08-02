#!/usr/bin/env python3
"""Wait out the meeting, then bring back what was said.

This is the long pole of the flow: it polls the bot until the call ends —
minutes or hours, bounded by max_wait_minutes — then fetches the transcript
and flattens it to `Speaker: text` lines for the notes prompt.

It is also where every upstream failure surfaces. Handed no bot_id (the join
step failed), it answers outcome=failed carrying the join's own error, so the
flow's failure end always states the first thing that went wrong.

Environment:
  RECALL_API_KEY        required — same key join_meeting used
  RECALL_REGION         the dashboard region the key belongs to (default us-west-2)
  RECALL_BASE_URL       full API origin, overriding the region (tests, self-host)
  RECALL_POLL_SECONDS   seconds between status checks (default 30)
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

TIMEOUT_SECONDS = 30
TERMINAL_CODES = {"done", "fatal", "analysis_done"}


def answer(outcome, transcript="", error=""):
    json.dump(
        {"outcome": outcome, "transcript": transcript, "error": error},
        sys.stdout,
    )
    sys.exit(0)


def failed(error):
    answer("failed", error=error)


def base_url():
    explicit = os.environ.get("RECALL_BASE_URL", "").strip().rstrip("/")
    if explicit:
        return explicit
    region = os.environ.get("RECALL_REGION", "").strip() or "us-west-2"
    return f"https://{region}.recall.ai"


def get_json(path, api_key):
    """GET one API path, or a plain URL when the transcript lives elsewhere."""
    url = path if path.startswith("http") else f"{base_url()}{path}"
    request = urllib.request.Request(
        url, headers={"Authorization": f"Token {api_key}"}
    )
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as reply:
        return json.load(reply)


def latest_status(bot):
    changes = bot.get("status_changes") or []
    if changes:
        return str(changes[-1].get("code") or "")
    return str(bot.get("status") or "")


def transcript_urls(bot):
    """Where this bot's transcript might be, in the order worth trying.

    Recall's newer API hangs a download URL off the recording; the older one
    serves GET /bot/{id}/transcript/. Trying both keeps the tool working
    across accounts on either shape.
    """
    urls = []
    for recording in bot.get("recordings") or []:
        data = (
            (recording.get("media_shortcuts") or {}).get("transcript") or {}
        ).get("data") or {}
        if data.get("download_url"):
            urls.append(data["download_url"])
    urls.append(f"/api/v1/bot/{bot.get('id')}/transcript/")
    return urls


def flatten(segments):
    """Transcript JSON to `Speaker: text` lines, tolerating both shapes."""
    lines = []
    for segment in segments if isinstance(segments, list) else []:
        if not isinstance(segment, dict):
            continue
        participant = segment.get("participant") or {}
        speaker = (
            segment.get("speaker")
            or participant.get("name")
            or "Unknown speaker"
        )
        words = segment.get("words") or []
        text = " ".join(
            str(word.get("text") or "").strip()
            for word in words
            if isinstance(word, dict)
        ).strip()
        if text:
            lines.append(f"{speaker}: {text}")
    return "\n".join(lines)


def main():
    try:
        args = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError) as exc:
        failed(f"could not parse input JSON: {exc}")

    bot_id = str(args.get("bot_id") or "").strip()
    join_error = str(args.get("join_error") or "").strip()
    if not bot_id:
        failed(join_error or "no bot_id — the join step did not produce one")

    try:
        max_wait_minutes = float(args.get("max_wait_minutes") or 180)
    except (TypeError, ValueError):
        max_wait_minutes = 180
    try:
        poll_seconds = float(os.environ.get("RECALL_POLL_SECONDS") or 30)
    except ValueError:
        poll_seconds = 30
    poll_seconds = max(1.0, poll_seconds)

    api_key = os.environ.get("RECALL_API_KEY", "").strip()
    if not api_key:
        failed("RECALL_API_KEY is not set")

    deadline = time.monotonic() + max_wait_minutes * 60
    bot = None
    misses = 0
    while True:
        try:
            bot = get_json(f"/api/v1/bot/{bot_id}/", api_key)
            misses = 0
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:300]
            failed(f"Recall.ai refused the status check ({exc.code}): {detail}")
        except (urllib.error.URLError, OSError, ValueError) as exc:
            # One dropped poll is weather; several in a row is an outage.
            misses += 1
            if misses >= 5:
                failed(f"lost contact with Recall.ai while waiting: {exc}")

        if bot is not None:
            code = latest_status(bot)
            if code == "fatal":
                changes = bot.get("status_changes") or []
                detail = changes[-1].get("sub_code") or "" if changes else ""
                failed(
                    "the bot could not stay in the meeting"
                    + (f" ({detail})" if detail else "")
                    + " — check the link is right and that the bot was "
                    "admitted from the waiting room"
                )
            if code in TERMINAL_CODES:
                break

        if time.monotonic() >= deadline:
            failed(
                f"the meeting was still running after {max_wait_minutes:g} "
                "minutes — raise max_wait_minutes if it was expected to run "
                "longer"
            )
        time.sleep(min(poll_seconds, max(0.1, deadline - time.monotonic())))

    transcript = ""
    errors = []
    for url in transcript_urls(bot):
        try:
            transcript = flatten(get_json(url, api_key))
        except urllib.error.HTTPError as exc:
            errors.append(f"{url}: HTTP {exc.code}")
            continue
        except (urllib.error.URLError, OSError, ValueError) as exc:
            errors.append(f"{url}: {exc}")
            continue
        if transcript:
            break

    if not transcript:
        failed(
            "the meeting ended but no transcript came back — with the "
            "meeting_captions provider, captions must be turned on in the "
            "meeting itself for there to be one"
            + (f" (tried: {'; '.join(errors)})" if errors else "")
        )

    answer("captured", transcript=transcript)


if __name__ == "__main__":
    main()
