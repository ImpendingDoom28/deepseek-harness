---
description: "Debug-mode status chip for the Web GUI: the composer control that shows debug mode is on and turns it off; for users and maintainers of debug mode."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-debug

English | [中文](README.zh.md)

## Summary

This package renders the debug-mode status chip in the Web GUI: when the host-computed projection's effective target is debug mode, the composer shows a red "Debug ×" button that turns debug mode off; otherwise the seat stays empty. Debug mode itself — the `/debug` command, the committed `debug/mode` state, the projection unit, and the policy section — belongs to `dsh-debug`; this package only renders the projection and sends what a user could equally type.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin alongside `ui-conversation` and `dsh-debug`; the chip then occupies the composer's debug seat next to the plan control whenever debug mode is active. Enter debug mode through the `/debug <issue>` command path — choose Debug from the composer's `+` Command menu or type `/debug` — and turn it off with the chip. Marking an issue fixed through `finish_debug` also ends the mode, so the chip disappears with the resolution.

### What the chip shows

While the effective target is debug mode, the seat renders the red "Debug ×" status button, which executes `/debug off`. Otherwise the seat stays empty: a host without debug mode, or a Draft with no session, shows nothing.

### Failures

Admission failures (`matched: false`, business errors, transport faults) surface as an inline error and the chip stays until the projection confirms the exit.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The chip occupies the conversation-declared `conversation.input.debug` single seat; the node half is an empty apply (the roster row). Reads ride the generic projection pair through the standard-kit `useProjection`: the effective target is `pending ? !active : active` — a folded host value, not client optimism, so an arriving frame corrects the chip either way. The seat's injected face carries one verb, `exitDebugMode`, which executes `/debug off` through `ctx.remote.commands.execute` and maps admission failures to an inline error line. The chip copy lives in this package's `debug` locale namespace. The accessible description is "Debug mode on, press to turn off".

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the debug surface is not enough. They move from the chip to the debug-mode domain and the composer shell.

- [dsh-debug](../../debug/debug-mode/README.md) — owns debug mode, the `/debug` command, the projection, and the policy section.
- [ui-conversation](../ui-conversation/README.md) — declares the composer's `conversation.input.debug` seat.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the `/debug off` command line the chip dispatches: `dsh-debug` owns the model-visible policy section and the logged state that line drives.

#### KV Cache effect

Entering or leaving debug mode changes the active `debug:policy` system-prompt section and therefore the request prefix; the chip itself adds no prompt content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the current debug chip. They are current package constraints, not a debug-mode comparison or a task backlog.

- **Debug mode is guidance, not an execution sandbox** — deployments that require enforced restrictions must compose the independent sandbox and approval policies.
- **The chip belongs to the default composer** — a pending whole-composer interaction such as the debug review temporarily replaces the InputBar and its chip.
- **No inactive debug control** — entry uses the shared Command source; a session with the capability but inactive mode shows no debug affordance in the tool row.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Debug state and boundary ownership are audited by dsh-debug, while the control is a slot effect whose declaration, registration, and teardown are exercised by this package.
