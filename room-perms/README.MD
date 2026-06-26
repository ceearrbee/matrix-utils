# Room Permissions

Log into any Matrix homeserver and see, for every room your account is joined
to, the room version, your power level, and exactly what you can and cannot do
(send messages, invite, kick, ban, redact others, change room settings,
tombstone, …) — including which power-level permissions are explicitly set
versus falling back to the spec defaults. Results are shown as a per-room list,
a rooms × permissions grid, or a chart of your standing across rooms.

Read-only: it never changes any room state. Runs entirely client-side; your
access token stays in `sessionStorage`. Tests: `node --test`.
