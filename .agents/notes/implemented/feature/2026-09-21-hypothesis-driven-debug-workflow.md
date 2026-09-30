# Agent Note: Hypothesis-driven debug workflow

Status: implemented

English | [中文](2026-09-21-hypothesis-driven-debug-workflow.zh.md)

## Problem

The presets' debug workflow prompt told the model to investigate, apply a tentative fix when it believed it had found the root cause, and instrument around that fix. The first `finish_debug` review therefore measured a world the unproven fix had already altered, so the captured entries could not separate "this change was the cause" from "this change alters behavior", and a wrong fix re-entered the loop with no record of which candidate causes had been eliminated. The prompt also left the loop's end to the model's own judgment, while the product's decision point is the user's **Mark as fixed** answer to `finish_debug`.

## Decision

The deployment-owned `prompt` of `@deepseek-ai/dsh-debug` — mounted identically by the [standard, ptc, and cordis presets](../../../../packages/bundle/web-app/README.md) — is now a hypothesis-driven loop:

1. Examine the code and investigate the issue, then define 5 hypotheses for why the user is facing the issue.
2. Add temporary `[debug-mode]` instrumentation that proves each hypothesis, POSTing the evidence to the loopback debug-log endpoint.
3. Call `finish_debug` with the reproduction steps and stop.

When the user answers **Proceed**, the model reads the captured entries, fixes the proven hypotheses, skips the rejected ones, and — when none were proven by the data — generates new hypotheses and changes the instrumentation accordingly before calling `finish_debug` again. The loop repeats until the user presses **Mark as fixed**, at which point the model removes all `[debug-mode]` instrumentation and preserves the fix.

The tentative-fix step is gone: a hypothesis is turned into a fix only once the captured data proves it. The mechanism is unchanged — same `debug:policy` section, same loopback endpoint, same `finish_debug` contract; only the prompt text the presets mount changed.

## Alternatives considered

**Keep the tentative fix and add hypothesis tracking beside it.** The fix and the hypotheses would be two competing theories of the cause, and the captured entries would still measure a world the unproven fix had altered; removing the fix is cheaper, and the fix reappears as the consequence of a proven hypothesis.

**Carry the hypothesis rules in the `finish_debug` tool description.** The tool stays registered while debug mode is inactive, so its description is a stable, always-present schema; the hypothesis workflow applies only inside an active session, which is exactly what the mode-scoped `debug:policy` section is for.

**Make the hypothesis count a configuration field.** The `{ prompt }` configuration contract is deliberately the whole surface; the count is prompt content, not a deployment-varying tunable, so it lives in the prompt text.

## Consequences

The shipped prompt is longer, so active debug mode adds more tokens per request. The first review cycle now returns evidence for five candidate causes rather than the behavior of one tentative fix, and a session where none of the five hypotheses is proven costs one extra review round (new hypotheses, re-instrumentation, another `finish_debug`). The loop's terminal condition is the user's **Mark as fixed** answer rather than the model's judgment.

The [package README](../../../../packages/debug/debug-mode/README.md) and the [subsystem page](../../../../docs/subsystems/debug.md) describe the loop in the hypothesis-driven terms; the exact prompt wording is owned by the preset `agent.cordis.yml` files.
