# Agent Note: One-shot debug mode

Status: implemented

English | [中文](2026-09-10-one-shot-debug-mode.zh.md)

**Superseded for the debug-mode shape by the [logged debug mode](2026-09-16-logged-debug-mode.md):** debug mode is now logged per-agent state like plan mode — a `debug/mode` event, a projection unit, the `debug:policy` system-prompt section (order 550) that carries the workflow prompt instead of the user message, and a composer chip. The decisions below that the logged design did not reverse — the verdict delivered as the tool result, the review failure boundary, and the fixed `{ prompt }` configuration — remain this note's home. The log-capture mechanism, now the loopback debug-log endpoint and its per-cycle lifecycle, is described by the logged-debug-mode note.

## Problem

Debugging a reported issue is a multi-step exchange — investigate, add logging, have the user run it, read the logs, fix, repeat — that the existing turn-by-turn conversation handles only if the user manually drives each hand-off. There was no first-class "stop and collect evidence" boundary: the model could not cleanly block on a human decision ("reproduced?" / "fixed?") the way plan mode blocks on a reviewed exit, and nothing owned the lifecycle of the temporary log file, so instrumentation and stale `debug.txt` content would accumulate across attempts.

The natural mirror of plan mode was the wrong shape. Plan mode is logged per-agent state (`plan/mode`) that survives resume and fork and needs a boundary append; a debug session is a one-shot, repeatable loop the model drives, with no durable stance to recover. Copying the plan-mode state machine would add a logged event, a projection unit, and a resume/fork fold for a state that does not exist.

## Decision

Debug mode is a stateless one-shot workflow owned by `@deepseek-ai/dsh-debug` at `packages/debug/debug-mode/` (`ctx.debug`, `DebugModeController`). It registers no prompt section, keeps no logged mode, and contributes no session event; the loop is model-driven and the session is ordinary conversation between reviews.

Two model-facing entries drive it. `/debug <issue>` (when `ctx.commands` is composed) is required to carry an issue and steers the deployment `prompt` plus the reported issue, with any admitted attachments, through `agent.steer()` as one ordinary logged user message. `finish_debug` takes the steps to reproduce the issue as an ordered list — nothing else — and blocks on the [user-questions seam](../../../../docs/subsystems/user-questions.md) for a **Proceed** or **Mark as fixed** decision; the verdict is delivered to the model as the tool result, not a separately steered message, so the model-visible ⟺ logged rule holds without a new event.

The one-shot's log-capture mechanism — a model-written `debug.txt` at the workspace root, host-truncated to 0 bytes on **Mark as fixed**, absent on **Proceed** yielding a not-found note with the verdict still `reproduced` — is superseded by the loopback debug-log endpoint, which the [logged debug mode](2026-09-16-logged-debug-mode.md) note owns: instrumentation POSTs entries to a per-session endpoint while the mode is active, and **Proceed** returns the cycle's captured entries as the tool result.

Configuration is exactly `{ prompt: string }`; a missing, blank, or non-string `prompt` and any unknown key fail at load. The presets mount the package with a reference workflow prompt.

### Boundary and model contract

A dismissed review (the user took the turn back to type instead) is a failed call that tells the model to keep the instrumentation and wait; a missing interaction channel and a service reload during review also fail rather than silently continuing. Only the Web UI has a `debug-review` presentation; other interaction providers present the same request through their generic option flow.

## Alternatives considered

**Logged debug-mode state (plan-mode mirror).** This buys resume/fork recovery, but the loop has no durable stance to recover and the boundary-append machinery would run for nothing; the stateless loop is cheaper and matches the product.

**A user-steered "reproduced/fixed" message instead of a tool result.** This keeps `finish_debug` a fire-and-forget probe, but the verdict would not be the logged carrier of the model's next step, and the model would need to parse a free-form message; the in-turn tool result is the natural carrier.

**A configurable or model-chosen log path.** This adds a model-supplied input to validate and sandbox, for no product need; a fixed workspace-root constant keeps the host and the model in agreement about one location.

**The host deleting `debug.txt` on Mark as fixed.** Deleting leaves no file for the model to confirm is clean and makes a re-run start from an absent path; truncating to 0 bytes (create-if-missing) gives a stable, checkable post-condition.

## Consequences

The trade buys a clean, repeatable investigate-and-collect loop with a human decision point and a host-owned log lifecycle, at the cost of a single, capped host-owned log-capture channel (no multi-file or configurable logging) and a review that only the Web UI renders as a decision card. Because there is no logged state, a process exit during a review loses the in-flight review (the model must present again) — the same class of limitation as a plan-mode selection made after the turn's final pre-step — and `finish_debug` adds no tokens outside a session because it is a stable, always-present tool schema.
