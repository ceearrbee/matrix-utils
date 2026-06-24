# Matrix Room Re-Forge (Someday, I'll come up with better names)

Re-version a Matrix room and turn its encryption on or off by recreating it as a new
room, reproducing what the built-in upgrade does (tombstone, power levels, member
control over the new room, so this does it by hand.

**Upgrades are irreversible. Use at your own risk.**

## What's it do?

- Carried over: room version, encryption (keep / enable / disable), name, topic, power
  levels, creators (v12+ `additional_creators`), join rules, history visibility, guest
  access, server ACLs, avatar, canonical/alt aliases, and a tombstone link.
- Invited (not force-joined): members who were joined or invited, sent one at a time so
  one un-invitable user can't fail the whole upgrade.
- Not migrated: message history (clients follow the tombstone), pinned events, widgets,
  room account data, and (for Spaces) the child-room hierarchy.

## License

[GNU Affero General Public License v3.0](../LICENSE) (AGPL-3.0).
