# On-call

Sample content. The facts here are invented so that a correct answer can only
have come from this file — if the agent gets the escalation window right, it
read the mount rather than remembering something.

## Rotation

One primary and one secondary, swapping every Wednesday at 10:00 UTC. The
rotation is generated a quarter ahead and lives in `rota.yaml` in the platform
repository. Swaps are self-service: change the file, get one review from anyone
else on the rotation, merge. No approval from a manager is needed for a swap.

## Paging

The primary is paged for any P1 and for a P2 that has been open for four hours.
P3s and below never page; they land in the `#ops-inbox` channel and are triaged
at the Monday sync.

| Severity | Definition | Page |
|---|---|---|
| P1 | Customer-visible outage, or data at risk | Immediately |
| P2 | Degraded service, no data at risk | After 4 hours open |
| P3 | Internal or cosmetic | Never |

If the primary does not acknowledge within **12 minutes**, the page escalates to
the secondary. If the secondary does not acknowledge within a further 12
minutes, it escalates to the platform lead, and after that to the duty director.

## During an incident

1. Acknowledge the page. Acknowledging is not the same as fixing; it stops the
   escalation clock and nothing else.
2. Open an incident channel named `inc-<date>-<short-name>`.
3. Post the current understanding every 30 minutes, even when it has not
   changed. Silence reads as an unattended incident.
4. Mitigate before diagnosing. A rollback that restores service is a success
   even if nobody yet knows what broke.

## After an incident

A writeup is due within **five working days** for any P1, and for any P2 that
paged. It is blameless, it names no individual, and it is reviewed at the
fortnightly reliability meeting. An incident with no writeup after five days is
picked up by the platform lead, not by the person who was on call.
