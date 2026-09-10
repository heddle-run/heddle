# Passwords and sign-in

## Password reset

Everything is Google SSO. There is no separate company password, so a "reset my
password" request nearly always means a Google account recovery:

1. Go to accounts.google.com and use "Forgot password".
2. Recovery goes to the phone number on the account, not to email.
3. If the phone number is wrong or gone, IT has to reset it by hand — this
   needs a manager to confirm the identity of the person asking, in person or on
   video. No exceptions, and the rule exists because a phone-swap attack is the
   one that actually gets tried on us.

## Two-factor

Hardware keys for engineering and finance, the Google Authenticator app for
everyone else. SMS codes are turned off at the domain level and cannot be turned
back on for one person.

## Shared logins

There are none, and creating one is a fireable offence for the account holder.
Anything that looks like it needs a shared login needs a service account
instead — ask in #it-help.
