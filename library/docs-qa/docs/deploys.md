# Deploys

Sample content, invented for this bundle.

## Windows

Deploys to production run on weekdays between 09:00 and 16:00 UTC. Outside that
window a deploy needs a P1 incident open, or written sign-off from the duty
director in the incident channel.

There is no deploy freeze except in the last week of the financial year
(the week ending 31 March), when only incident fixes ship.

## The pipeline

`main` is always deployable. A merge to `main` builds an image, runs the test
suite, and deploys to staging automatically. Production is a manual promotion of
a staging build that has been up for at least **20 minutes** with no alerts.

Nothing is deployed from a branch. Nothing is deployed from a laptop.

## Rollback

Every promotion records the digest it replaced. `deployctl rollback` retags the
previous digest and restarts, which takes about 90 seconds end to end. Rolling
back is not an incident in itself and needs no approval — if you are wondering
whether to roll back, roll back.

Database migrations are the exception: they are expand-and-contract, and the
contract half is a separate deploy at least one release later, so a rollback of
the application never leaves a schema the previous version cannot read.

## Ownership

The team that merged the change owns it in production for **24 hours**,
regardless of who is on call. On-call handles the page; the owning team handles
the fix.
