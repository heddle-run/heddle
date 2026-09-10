# Printing

One printer per floor, all of them Ricoh, all of them on the `print` VLAN.

## Adding a printer

macOS finds them over Bonjour when you are on office wifi. System Settings →
Printers & Scanners → Add, and pick the one named for your floor.

## Nothing comes out

Jobs are held for release: they print when you tap your badge on the reader.
An unreleased job is deleted after four hours, which accounts for most of the
"it printed nothing" reports.

## Printing from the VPN

You cannot. The print VLAN is not routed over Tailscale, on purpose. Printing
from home is not a thing we support.
