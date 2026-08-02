#!/usr/bin/env python3
"""Send a notetaker bot to a meeting.

The bot is Recall.ai's (https://recall.ai): one POST dispatches a headless
participant to the meeting URL, and it shows up in the call under `bot_name`
like anyone else joining late. This tool only dispatches — waiting for the
meeting to end and collecting what the bot heard is `await_transcript`'s job,
so a bad link or a bad key fails here, fast, before anything waits on a call.

Environment:
  RECALL_API_KEY   required — an api key from your Recall.ai dashboard
  RECALL_REGION    the dashboard region the key belongs to (default us-west-2)
  RECALL_BASE_URL  full API origin, overriding the region (tests, self-host)

Like every tool in the library: a failure is data, not a crash. The answer
always carries bot_id, status and error, and the flow branches on what the
downstream capture step reports.
"""

import json
import os
import re
import sys
import urllib.error
import urllib.request

TIMEOUT_SECONDS = 30


def answer(bot_id="", status="", error=""):
    json.dump({"bot_id": bot_id, "status": status, "error": error}, sys.stdout)
    sys.exit(0)


def base_url():
    explicit = os.environ.get("RECALL_BASE_URL", "").strip().rstrip("/")
    if explicit:
        return explicit
    region = os.environ.get("RECALL_REGION", "").strip() or "us-west-2"
    return f"https://{region}.recall.ai"


def main():
    try:
        args = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError) as exc:
        answer(error=f"could not parse input JSON: {exc}")

    meeting_url = str(args.get("meeting_url") or "").strip()
    bot_name = str(args.get("bot_name") or "").strip() or "heddle notetaker"

    if not meeting_url:
        answer(error="no meeting_url was given")
    if not re.match(r"^https?://", meeting_url):
        answer(error=f"meeting_url does not look like a link: {meeting_url!r}")

    api_key = os.environ.get("RECALL_API_KEY", "").strip()
    if not api_key:
        answer(
            error="RECALL_API_KEY is not set — the notetaker bot is a "
            "Recall.ai bot, and dispatching one needs an api key from "
            "https://recall.ai"
        )

    # meeting_captions rides the meeting's own caption stream, so the
    # transcript costs nothing extra and needs no third-party ASR key. The
    # trade is documented in the README: captions must be on in the meeting.
    body = json.dumps(
        {
            "meeting_url": meeting_url,
            "bot_name": bot_name,
            "recording_config": {
                "transcript": {"provider": {"meeting_captions": {}}}
            },
        }
    ).encode("utf-8")

    request = urllib.request.Request(
        f"{base_url()}/api/v1/bot/",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Token {api_key}",
            "Content-Type": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as reply:
            bot = json.load(reply)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        answer(error=f"Recall.ai refused the bot ({exc.code}): {detail}")
    except (urllib.error.URLError, OSError, ValueError) as exc:
        answer(error=f"could not reach Recall.ai at {base_url()}: {exc}")

    bot_id = str(bot.get("id") or "").strip()
    if not bot_id:
        answer(error=f"Recall.ai answered without a bot id: {json.dumps(bot)[:500]}")

    answer(bot_id=bot_id, status="joining")


if __name__ == "__main__":
    main()
