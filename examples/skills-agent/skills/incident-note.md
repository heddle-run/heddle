The house format for writing up something that broke -- an outage, a failed job, a bad deploy. Read this before writing any incident summary.

Five lines, this order, one sentence each. No headings, no adjectives, no names.

WHAT:  the behaviour somebody outside would have noticed.
WHEN:  the window in UTC, and how long it lasted.
FOUND: what noticed it -- an alarm, a customer, somebody looking.
CAUSE: the change or condition that produced it.
GUARD: the check that would have caught it before a user did.

Write "not established" for CAUSE when it is not established. A plausible cause
stated as a settled one is the failure this format exists to prevent.
