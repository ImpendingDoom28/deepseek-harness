# Debug Mode

English | [中文](debug.zh.md)

Debug mode is logged per-agent debug state owned by [dsh-debug](../../packages/debug/debug-mode) (`ctx.debug`, `DebugModeController`): while active, a deployment-owned workflow prompt is included in each model request as the `debug:policy` section, and the agent examines the code, defines 5 hypotheses for why the user is facing the issue, and adds temporary instrumentation that POSTs the evidence for each hypothesis to the loopback debug-log endpoint, then stops to hand the user the steps to reproduce the issue as an ordered list. **Proceed** keeps the loop running — the model fixes the proven hypotheses, skips the rejected ones, and when none were proven generates new hypotheses and re-instruments — until the user chooses **Mark as fixed**. Debug mode is **soft guidance**. [Sandbox mode](sandbox.md) and [approval policy](approval.md) enforce restrictions independently; neither reads or writes debug state, so deployments configure them separately. The package is optional, and the agent loop does not depend on it. It contributes the `debug:policy` prompt section and registers the `finish_debug` tool and the `/debug` command. The [design note](../../.agents/notes/implemented/feature/2026-09-16-logged-debug-mode.md) owns the rationale; the [package README](../../packages/debug/debug-mode/README.md) owns the model-experience and limitation detail.

Source: [`packages/debug/debug-mode/src/index.ts`](../../packages/debug/debug-mode/src/index.ts)

## Logged state and recovery

`debug/mode` (`{ active: boolean }`) is a log-only, whole-value-replace [session event](session.md): durable and replayable, never in the model transcript. `debug/log` (`{ step, at, data? }`) is a log-only, order-preserving entry appended from the loopback debug-log endpoint; the last `debug/mode` and the accumulated `debug/log` entries fold the `debug` unit, which also tracks committed mode, command settlement, the mode recorded at the latest request header, and the current cycle's captured entries. `ctx.debug` reads that state through `stateOf()`; the first dependent access fails if the registry, `debug` key, or `turnBoundary` key is absent. Clients receive only `{ active, pending, logs }`; resume, fork, and compaction recover all three from the log. The complete event declaration is in the [persistence log event catalog](../persistence-catalog.md).

## The loopback debug-log endpoint

The service listens on a loopback HTTP endpoint for its lifetime, at `http://127.0.0.1:<port>/debug/<sessionId>`; the `debug_log_url` prompt variable resolves it for the active session so the `debug:policy` prompt can name the exact URL. The model's instrumentation POSTs one JSON object or NDJSON body of `{ step, at, data? }` entries while debug mode is active; each accepted entry is appended as a `debug/log` event, and each mode change starts a new cycle with an empty log window. A POST to an unknown session, an inactive session, or a malformed body is refused (404/400); an over-cap body or a full window is refused (413/429). **Proceed** returns the cycle's captured entries as the tool result — when none were captured the tool still answers, with a note that none were captured, so the model can ask the user to re-run or fix the instrumentation. **Mark as fixed** ends the session; the cycle's entries are discarded with the mode and the endpoint accepts no further entries once the mode is logged inactive.

## Pending selections and the pre-step append

Because every session event is turn-enclosed, a user selection remains pending until the next accepted in-turn pre-step appends it before request derivation, in whichever turn that occurs. A selection never forces continuation, so one made after a turn's final accepted pre-step is appended in a later turn. `set(agent, active)` records the pending selection (a no-op when the target equals the logged-or-already-pending state), and `get(agent)` returns `{ active: boolean; pending?: boolean }`: the logged state used to assemble the current step plus the selected state waiting to be appended.

The only append point while an agent is running is a prepended `agent/pre-step` listener. It observes every proposed request step, including turn 1 step 1 and request-recovery retries, calls downstream listeners first, and appends only after they accept the step. An append failure cannot block the turn, and the selection remains pending for a later accepted in-turn pre-step. An appended user selection also records one plugin-sourced `user/message` notice, but only when the last logged request header described the other state, so the model is told exactly when its context changed and never redundantly. A selection made after a turn's final accepted pre-step remains process-local and is lost if the process exits before another accepted in-turn pre-step ([README limitation](../../packages/debug/debug-mode/README.md#known-limitations-and-deferred-work)).

## Configuration

```ts type-equiv
/**
 * Deployment-owned debug workflow guidance.
 */
interface DebugModeConfig {
  /**
   * The debug workflow prompt, rendered as the `debug:policy` prompt section
   * while debug mode is active. Required and non-empty; unknown keys fail at
   * load.
   */
  prompt: string
}
```

A missing, blank, or non-string `prompt` and any unknown key fail at plugin load rather than being ignored. While debug mode is active, the exact `prompt` text renders as the `debug:policy` [system-prompt section](system-prompt.md) at order 550; inactive debug mode contributes no text.

## The `finish_debug` tool and the `/debug` command

When [`ctx.commands`](commands.md) is composed, the plugin registers `/debug <issue>` and `/debug off`. `/debug <issue>` is required to carry an issue and selects debug mode, then steers the reported issue — with any attached images or files — through `agent.steer()` so it becomes the next step's ordinary logged user message under the `debug:policy` guidance; the workflow prompt itself is not injected into the message. The exact argument `off` selects inactive, which also cancels a pending entry before it is appended and becomes visible to a request. An empty issue is rejected before the turn starts.

[`finish_debug`](../tool-catalog.md#deepseek-aidsh-debug) stays in the model-facing tool catalog so entering or leaving debug mode adds no tool-catalog churn; it is only meaningful during a debug session. It takes the steps to reproduce the issue as an ordered list and blocks until the active UI answers **Proceed** or **Mark as fixed** over the [user-questions seam](user-questions.md). **Proceed** keeps the session in debug mode and returns the cycle's captured log entries (the entries the endpoint accepted since the last verdict or mode entry) as the tool result. **Mark as fixed** records a silent (non-narrated) pending exit that is appended at the next accepted in-turn pre-step, so guidance remains for the rest of the assistant's current tool batch and the tool result itself reports the transition. The verdict is delivered to the model as the tool result — not a separately steered message — so the model-visible ⟺ logged rule holds without a new session event. A dismissed review, a missing interaction channel, and a service reload during review all fail the call rather than silently continuing.

## The service

`ctx.debug` owns the logged debug state, applies and narrates selected state at step start, and owns the `debug:policy` section, the loopback debug-log endpoint, the `/debug` command, and the stable `finish_debug` tool; `get`/`set` signatures are in the generated [service catalog](#ctxdebug--debugmodecontroller).

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxdebug--debugmodecontroller"></a>

### `ctx.debug` — `DebugModeController`

`ctx.debug`: owns logged debug state, applies and narrates selected state at step start, the `debug:policy` section, the loopback debug-log endpoint, the `/debug` command, and the `finish_debug` tool. Client carriers expose the projection's cropped `{ active, pending, logs }` view.

```ts cordis-catalog
/**
 * Read the logged debug state and any selected state awaiting the next
 * accepted in-turn pre-step.
 *
 * @param agent The agent to read.
 * @returns Current logged state plus a pending selection, when present.
 */
get(agent: Agent): { active: boolean; pending?: boolean }

/**
 * Select whether debug mode should be active. Between turns the method
 * appends the change immediately because no in-turn pre-step will run until
 * another prompt starts a turn. The open-turn fold is the idle signal:
 * agent status stays `running` through post-turn checkpointing, when no
 * further in-turn pre-step runs. During an open turn the selection remains
 * pending until the next accepted in-turn pre-step. Repeated selection of
 * the current or already-pending state is a no-op.
 *
 * @param agent The agent to switch.
 * @param active Whether debug mode should be active.
 * @returns what happened: `committed` (logged now), `queued` (awaiting the
 * next accepted in-turn pre-step), `cancelled` (an opposite pending selection
 * was cleared; the logged state already matches), or `noop` (already in that
 * state).
 */
set(agent: Agent, active: boolean): 'committed' | 'queued' | 'cancelled' | 'noop'
```

Types: [Agent](core.md)

Source: [`packages/debug/debug-mode/src/index.ts`](../../packages/debug/debug-mode/src/index.ts)
<!-- END GENERATED cordis-surface -->
