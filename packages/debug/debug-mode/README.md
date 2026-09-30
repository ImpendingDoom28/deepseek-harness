---
description: "Logged debug mode for users and maintainers choosing, configuring, or debugging the per-agent debug state: a deployment-owned prompt section, a loopback debug-log endpoint, a /debug command, and a user-reviewed finish_debug that returns the captured log entries on Proceed and ends the mode on Mark-as-fixed."
kind: "package-reference"
---

# @deepseek-ai/dsh-debug

English | [中文](README.zh.md)

## Summary

Debug mode turns a reported issue into a hypothesis-driven loop: `/debug <issue>` starts it, the agent examines the code, defines 5 hypotheses, and POSTs each hypothesis's evidence through temporary instrumentation to the loopback debug-log endpoint, and hands you the steps to reproduce the issue. **Proceed** (reproduced) keeps the mode and returns the captured log entries; the agent fixes the proven hypotheses, skips the rejected ones, and re-instruments when none were proven. **Mark as fixed** removes the instrumentation, keeps the fix, and ends the session. It is logged per-agent state like [plan mode](../../plan/plan-mode/README.md): it survives resume and fork.

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

The common path: configure the workflow prompt, start a debug session with `/debug`, and answer the `finish_debug` review with Proceed or Mark as fixed.

### When to choose it

Choose debug mode when the agent should investigate a reported issue, gather evidence through the debug-log endpoint before committing to a fix, and hand you the reproduction steps. It does not restrict the agent: every tool stays callable, so use sandbox mode and approval prompts for enforced limits. Skip it when the agent can diagnose and fix immediately, without a collect-and-review round.

### Minimal configuration

The only required configuration is the workflow prompt the agent follows in each session; anything else you add fails at load.

```yaml
- name: '@deepseek-ai/dsh-debug'
  config:
    prompt: |
      You are in a debug session. Investigate the issue, add temporary
      instrumentation that POSTs the relevant state to the debug-log endpoint
      at {{debug_log_url}}, and call finish_debug with the steps to
      reproduce the issue as an ordered list.
```

| Field | Default | Meaning |
|---|---|---|
| `prompt` | required | The debug workflow prompt, rendered as the `debug:policy` prompt section while debug mode is active |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-debug) is the exhaustive source for every accepted field and its JSDoc.

<a id="the-debug-command"></a>
### The `/debug` command

Type `/debug <issue>` to start a session: the issue text is required; it selects debug mode and is steered — with any attached images or files — as your next request, under the `debug:policy` guidance (the workflow prompt itself is not injected into the message). Type `/debug off` to leave: the selection takes effect from the next step, or immediately when the session is between turns, and a pending entry is cancelled if it has not been appended yet. An empty issue is rejected before the turn starts. The command is available wherever slash commands are supported, such as the Web client, where the active mode also shows the red **Debug** chip.

<a id="the-finish-debug-review"></a>
### The `finish_debug` review

When the agent has added the instrumentation, it calls `finish_debug` with the steps to reproduce the issue as an ordered list — nothing else, no prose and no notes on what to look for. You review those steps and choose **Proceed** (the issue is reproduced; the session stays in debug mode and the agent receives the captured log entries as the tool result) or **Mark as fixed** (the issue is resolved; the agent removes the instrumentation and preserves the fix, and the session leaves debug mode). When no entries were captured the agent is told that none were captured, so it can ask you to re-run the steps or fix the instrumentation. Closing the review to type a message instead tells the agent to keep the instrumentation and wait for your message.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package is a logged-mode controller, mirroring [plan mode](../../plan/plan-mode/README.md). It registers the stable `finish_debug` tool and the `debug:policy` prompt section (rendered only while active, pending-aware), and when `ctx.commands` is composed the `/debug` command. Debug state is the log-only `debug/mode` and `debug/log` events, folded by the registered `debug` projection unit; `ctx.debug.get`/`set` expose the logged-or-pending state, and a prepended `agent/pre-step` listener appends a pending selection before the next request assembly, with the standard user-switch notice. `finish_debug` blocks on the [user-questions seam](../../../docs/subsystems/user-questions.md) for its Proceed / Mark-as-fixed decision and delivers the verdict as the tool result, which keeps the model-visible ⟺ logged rule intact without a new session event. The loopback debug-log endpoint is the only path into `debug/log`: the service listens on it for its lifetime at `http://127.0.0.1:<port>/debug/<sessionId>` (the `debug_log_url` prompt variable resolves it), accepts `{ step, at, data? }` entries only while the session's mode is active, and appends each accepted entry as a `debug/log` event. The projection keeps the current cycle's entries within a sliding window (4,000 entries / 256,000 characters), and a mode change or a successful `finish_debug` starts a new cycle. When you choose Proceed, the finish tool reads that window and returns the entries as the tool result; when none were captured it returns a not-captured note rather than a failed call.

| File | Responsibility |
|---|---|
| `src/index.ts` | `DebugModeController`: the logged state, the `debug:policy` section, the loopback debug-log endpoint, the `/debug` command, and the `finish_debug` tool |
| `src/types.ts` | `DebugProjection`, `DebugUnitState`, and the `debug` projection key merge |
| `src/client.ts` | The `./client` export of the projection view types |
| — | No runtime invariant companion is published; the logged `debug/mode` and `debug/log` events are the sole source of truth and the projection folds them deterministically, so no diverging observation needs a guard. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Debug mode subsystem reference](../../../docs/subsystems/debug.md) — the logged state, the loopback debug-log endpoint, and the `/debug` command.
- [User interaction subsystem](../../../docs/subsystems/user-questions.md) — the seam `finish_debug` blocks on for its decision.
- [Plan mode package](../../plan/plan-mode/README.md) — the pattern debug mode follows: logged per-agent state, a policy section, and a reviewed exit that delivers its verdict as a tool result.
- [ui-debug package](../../client/ui-debug/README.md) — the Web composer chip that shows and turns off the active mode.
- [Adding a tool](../../../docs/cookbook/adding-a-tool.md) — how the `finish_debug` card and presenter are designed.

-----

<a id="model-experience"></a>
## Model Experience

### Debug policy system prompt

#### What the model sees

While debug mode is active, the model sees the deployment's exact `prompt` text at first-party prompt order 550; inactive mode contributes no text. A pending entry is already treated as active, so the section renders from the first request after the selection, even before the log append lands.

##### Configuration example

```markdown
You are in a debug session. Investigate the issue, add temporary
instrumentation that POSTs the relevant state to the debug-log endpoint
at {{debug_log_url}}, and call finish_debug with the steps to
reproduce the issue as an ordered list.
```

#### Token effect

Inactive mode adds no tokens; active mode adds the configured prompt to every request.

#### KV Cache effect

The prompt is stable within debug mode, but entering or leaving changes the system prompt from first-party order 550 onward.

### Human command

#### What the model sees

`/debug <issue>`, `/debug off`, and their terminal results stay outside model history. The reported issue becomes one user message through `agent.steer()` after debug mode is selected: admitted image and file blocks in selection order, then the trimmed issue text. The workflow prompt is never part of that message. A narrated active or inactive user selection contributes the standard logged user-switch notice only when the last request header described the other mode; cancelling a pending entry contributes none because no request observed it.

#### Token effect

The issue costs the same history tokens as submitting that content separately; the prompt itself rides the system prompt while active. A narrated switch adds the small retained switch notice.

#### KV Cache effect

The user message is append-only conversation growth. Entering or leaving debug mode changes the earlier policy section; a narrated switch notice is appended after the reusable request prefix.

### The `finish_debug` schema and review exchange

#### What the model sees

The [`finish_debug` schema](../../../docs/tool-catalog.md#deepseek-aidsh-debug) remains available in both states, so entering or leaving debug mode adds no tool-catalog churn; the tool is only meaningful during a session. **Proceed** returns the model the reproduced note — with a not-captured variant when no log entries were captured — and the session stays in debug mode. **Mark as fixed** returns the fixed note and ends the session: the guidance stays active for the rest of the assistant's current tool batch, and the silent exit is appended at the next accepted in-turn pre-step, so no separate switch notice is logged. A dismissed review is a failed call naming the user's takeover.

#### Token effect

The stable schema is paid according to ToolRuntime mode, and each `finish_debug` call and its verdict remain in conversation history.

#### KV Cache effect

Mode transitions do not change the tool catalog; the verdict extends the conversation normally, and the silent exit changes the earlier policy section at the next step.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe when debug mode does not behave as you might expect or needs extra care. They are current package constraints, not a roadmap.

- **The log window is capped** — the projection keeps at most 4,000 entries or 256,000 characters per cycle, and a POST beyond either cap is refused (429); an over-1 MiB body is also refused (413), so a long session keeps only the newest entries within the window.
- **Proceed never verifies the log** — when no entries were captured the verdict (reproduced) still stands with a not-captured note, so the model must re-run the steps or fix the instrumentation.
- **One specialized review renderer** — only the Web UI has a `debug-review` presentation; another interaction provider presents the same request through its generic option flow.
- **A pending selection is process-local** — a selection made after a turn's final accepted pre-step is lost if the process exits before another accepted in-turn pre-step, the same class of limitation as plan mode.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open design questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Note.

None.

</details>
