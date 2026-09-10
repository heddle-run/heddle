# VPN

The company VPN is Tailscale, on the `northwind` tailnet. Everyone gets access on
their first day; contractors get a 90-day node key that expires without warning.

## Connecting

1. Open Tailscale from the menu bar and sign in with your work Google account.
2. Accept the "Northwind" tailnet invitation if you are prompted for one.
3. Check the connection with `tailscale status` — you want `northwind` and a
   green dot, not `logged out`.

## When it will not connect

The single most common cause is an expired node key, which looks like a
successful login followed by no traffic. Run `tailscale up --force-reauth` and
sign in again. This is normal for contractors every 90 days and is not a fault.

Corporate coffee-shop wifi that blocks UDP will also stop it. Tailscale falls
back to a relay and everything gets slow rather than failing outright; if the
office feels fine and the café does not, this is why.

## What the VPN does not cover

The finance systems sit behind a separate Cloudflare Access policy. Being on the
VPN does not sign you into them and never has.
