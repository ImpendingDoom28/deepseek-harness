---
description: "Package map for the debug group: the logged debug mode that investigates an issue, instruments it through the loopback debug-log endpoint, and reviews the captured logs with the user, for users and maintainers navigating the group."
kind: "package-group"
---

# debug/ — logged debug mode

English | [中文](README.zh.md)

## Summary

The `debug/` group provides logged per-agent debug mode: you report an issue with `/debug <issue>`; the agent investigates, adds temporary instrumentation that POSTs log entries to a loopback debug-log endpoint, and hands you the steps to reproduce the issue. You answer **Proceed** (reproduced — it keeps the mode and receives the captured entries as the tool result) or **Mark as fixed** (it removes the instrumentation and keeps the fix, ending the session). The mode and captured entries recover from the session log across resume, fork, and compaction; `/debug off` leaves the mode. One package, `debug-mode`.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

One package provides the whole debug workflow; the subsystem reference owns the shared vocabulary.

| Package | Role | ctx key |
|---|---|---|
| [`debug-mode/`](debug-mode/README.md) | Provides logged debug mode: `/debug` activates it, the agent instruments the loopback debug-log endpoint, and `finish_debug` hands you the reproduction steps for a Proceed / Mark-as-fixed review | `ctx.debug` |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the subsystem reference for the shared vocabulary, then read the package README for configuration and the model experience.

- [Debug mode subsystem reference](../../docs/subsystems/debug.md) — the loopback debug-log endpoint, the `finish_debug` review arc, and the `/debug` command.
- [User interaction subsystem](../../docs/subsystems/user-questions.md) — the seam `finish_debug` blocks on for its Proceed / Mark-as-fixed decision.

<a id="dev-note"></a>
## Dev Note

None.
