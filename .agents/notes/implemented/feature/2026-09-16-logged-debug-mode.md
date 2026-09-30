# Agent Note: Logged debug mode

Status: implemented

English | [中文](2026-09-16-logged-debug-mode.zh.md)

## Problem

Debug mode shipped as a stateless one-shot ([one-shot debug mode](2026-09-10-one-shot-debug-mode.md)), and its two seams showed it. The workflow prompt was steered *into the user message* alongside the reported issue, so a debug session's defining text lived in user-visible conversation content — it leaked into session titles and any other derivation from user messages, and every `/debug` re-injected the whole workflow prompt into the history as if the user had typed it. Separately, the one-shot had no logged state: the client could not know the session was debugging, so there was no affordance to see the mode or leave it except typing `/debug off`, and a resume or fork lost the context entirely.

The plan-mode mirror was rejected as the *first* design because a debug session looked like a loop with no durable stance; in practice the product need was the opposite — a mode the user can see, enter, and leave, like plan mode.

## Decision

Debug mode is logged per-agent state, exactly like [plan mode](../../../../docs/subsystems/plan.md), owned by `@deepseek-ai/dsh-debug` at `packages/debug/debug-mode/` (`ctx.debug`, `DebugModeController`).

- `debug/mode` (`{ active: boolean }`) is a log-only, whole-value-replace [session event](../../../../docs/subsystems/session.md); the additive event needs no `SESSION_FORMAT_VERSION` bump. The `debug` projection unit folds it with command settlement and the mode at the latest request header; clients receive the cropped `{ active, pending, logs }` view, which the new `ui-debug` package renders as the red composer chip that executes `/debug off`.
- Log capture moves from the model-written `debug.txt` file to a loopback debug-log endpoint. The service listens on `http://127.0.0.1:<port>/debug/<sessionId>` for its lifetime (the `debug_log_url` prompt variable resolves the URL, so the `debug:policy` prompt can name it), accepts `{ step, at, data? }` entries — JSON object or NDJSON — only while the session's mode is active, and appends each accepted entry as a log-only, order-preserving `debug/log` event. The projection keeps the current cycle's entries in a sliding window (4,000 entries / 256,000 characters over `step + JSON.stringify(data)`); a mode change or a successful `finish_debug` starts a new cycle with an empty window, while a failed `finish_debug` keeps it. The window is the finish tool's source: **Proceed** reads it and returns the entries as the tool result, and when it is empty the tool returns a not-captured note (verdict still `reproduced`) so the model can ask the user to re-run or fix the instrumentation.
- The deployment `prompt` is no longer steered. It renders as the `debug:policy` [system-prompt section](../../../../docs/subsystems/system-prompt.md) at first-party order 550 (between `PLAN_POLICY` 500 and `TEAM_POLICY` 600), visible only while the mode is active or an entry is pending — so user messages, and everything derived from them (session naming above all), carry only the reported issue.
- `/debug <issue>` selects active and steers the issue (plus admitted attachments) as the next ordinary user message; `/debug off` selects inactive and cancels a pending entry. Both follow the plan-mode `set()` settlement: `committed` between turns, `queued` in-turn with the pre-step append, `cancelled`, or `noop`, with the standard narrate-when-the-last-header-differed user-switch notice.
- `finish_debug` keeps its shape and verdict-as-tool-result delivery. It takes the steps to reproduce the issue as an ordered list — nothing else, no prose and no "what to look for" notes — so the review card shows only the reproduction steps the user must run. **Proceed** keeps the session in debug mode and returns the cycle's captured log entries as the tool result.
- The review takeovers (plan review, debug review) render through one shared decision card in `ui-user-questions` (`ReviewCard` plus the `useReviewCard` behavior hook), so the two cards share markup and behavior without a duplicated component; each panel keeps its own CSS module, identity attributes, and copy. The debug card is red-tinted (error/danger tokens) like the debug-mode chip, against the neutral plan review card. **Mark as fixed** records a silent (non-narrated) pending exit, appended at the next accepted in-turn pre-step — the same deferral as plan mode's approved exit — so the session ends with the resolution and the chip disappears.

The `{ prompt: string }` configuration contract and the review boundary (dismissed = failed call that waits, missing channel and service reload fail loud) carry over from the one-shot note unchanged; the log-capture mechanism they describe is the loopback debug-log endpoint, owned here.

## Alternatives considered

**Keep the one-shot, fix the prompt placement only.** Moving the prompt to a system section without a logged state still leaves the client unable to display or exit the mode, and the section would have no per-agent state to key on; the mode state is the cheaper and more complete answer.

**A client-only mode flag (no session event).** The state would not survive resume or fork, would not reach the model through the log, and would break the model-visible ⟺ logged rule the instant the policy section became state-dependent.

**Reuse `PLAN_POLICY`'s order or a higher slot.** Order 550 keeps debug guidance adjacent to plan guidance in the prompt while remaining a distinct first-party slot the `SECTION_ORDERS` gate enforces.

## Consequences

Debug sessions now behave like plan sessions for state: durable, resume- and fork-recoverable, client-visible through the projection, and narrated exactly once per actual context change. The cost is the same machinery plan mode pays — log events (`debug/mode` and `debug/log`), one projection unit, one pre-step listener, one prompt section, plus the loopback debug-log endpoint — plus the `ui-debug` chip package. Entering or leaving changes the request prefix from order 550 onward, and active mode adds the configured prompt to every request. A pending selection made after a turn's final accepted pre-step is process-local and lost on process exit, the same limitation plan mode carries. The one-shot note stays active with a supersession pointer: the decisions it made that this one did not reverse (verdict as tool result, review failure boundary, fixed config) remain its home; the per-cycle log reset that replaced `debug.txt` truncation-on-fix is described above.
