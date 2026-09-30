# 调试模式

[English](debug.md) | 中文

调试模式是 [dsh-debug](../../packages/debug/debug-mode) 拥有的、记录到日志的逐 agent（智能体）调试状态（`ctx.debug`，`DebugModeController`）：激活期间，每个模型请求都会包含一段部署持有的工作流提示词（`debug:policy` 段落），agent 检查代码、定义 5 个假设以解释用户为何遇到该 issue（问题）、并添加把每个假设的证据 POST 到回环 debug-log 端点的临时插桩（instrumentation），然后停下来把复现该 issue 的步骤以有序列表的形式交给用户。**Proceed**（继续）让循环继续——模型修复被证实的假设、跳过被否决的假设，并在没有任何假设被证实时生成新的假设并重新插桩——直到用户选择 **Mark as fixed**（标记已修复）。调试模式是**软性指引**。[沙箱模式](sandbox.zh.md)与[审批策略](approval.zh.md)分别强制限制；两者都不读写调试状态，因此部署需要分别配置它们。该包是可选项，agent loop（智能体循环）不依赖它。它贡献 `debug:policy` 提示词段落，并注册 `finish_debug` 工具和 `/debug` 命令。[设计说明](../../.agents/notes/implemented/feature/2026-09-16-logged-debug-mode.zh.md)负责决策依据；[包 README](../../packages/debug/debug-mode/README.zh.md)负责模型体验与限制细节。

源码：[`packages/debug/debug-mode/src/index.ts`](../../packages/debug/debug-mode/src/index.ts)

## 已记录状态与恢复

`debug/mode`（`{ active: boolean }`）是仅记日志、整值替换的[会话事件](session.zh.md)：持久且可回放，绝不进入模型 transcript（文本记录）。`debug/log`（`{ step, at, data? }`）是仅记日志、保序的条目，由回环 debug-log 端点追加；最后一次 `debug/mode` 与累积的 `debug/log` 条目折叠成 `debug` 单元，该单元还跟踪已提交模式、命令结算结果、最近一次请求头记录的模式以及当前周期捕获的条目。`ctx.debug` 通过 `stateOf()` 读取该状态；注册表、`debug` key 或 `turnBoundary` key 缺失时，第一次依赖它们的访问会失败。客户端只接收 `{ active, pending, logs }`；恢复、fork 与压缩（compaction）都能从日志恢复三者。完整事件声明见[持久化日志事件目录](../persistence-catalog.zh.md)。

## 回环 debug-log 端点

服务在其生命周期内监听一个回环 HTTP 端点，地址为 `http://127.0.0.1:<port>/debug/<sessionId>`；`debug_log_url` 提示词变量为激活的会话解析该地址，使 `debug:policy` 提示词能够指明确切的 URL。调试模式激活期间，模型的插桩 POST 一个 JSON 对象或 NDJSON 体的 `{ step, at, data? }` 条目；每个被接受的条目都被追加为 `debug/log` 事件，且每次模式变更都以一个空的日志窗口开启新周期。向未知会话、未激活会话的 POST，或畸形 body，都会被拒绝（404/400）；超上限的 body 或已满的窗口都会被拒绝（413/429）。**Proceed**（继续）把当前周期捕获的条目作为工具结果返回——当没有捕获到任何条目时工具仍然作答，附一条未捕获到条目的说明，于是模型可以让用户重新运行或修复插桩。**Mark as fixed**（标记已修复）结束会话；该周期的条目随模式一起被丢弃，且模式记录为未激活后端点不再接受任何条目。

## 待生效选择与 pre-step 追加

由于每个会话事件都位于轮次之内，用户选择会保持待生效状态，直到下一个被接受的轮内 pre-step 在派生请求之前追加该选择，无论该 pre-step 位于哪个轮次。选择不会强制续行，因此在某轮最后一个被接受的 pre-step 之后作出的选择会在之后的轮次追加。`set(agent, active)` 记录待生效选择（目标值与已记录或已在等待的状态相同时不做任何事），`get(agent)` 返回 `{ active: boolean; pending?: boolean }`：用于组装当前步骤的已记录状态，以及等待追加的已选状态。

agent 运行时，唯一的追加点是前置（prepend）注册的 `agent/pre-step` 监听器。它会观察每个候选请求步骤，包括第 1 轮第 1 步和请求恢复重试；它先调用下游监听器，只在下游接受该步骤后追加。追加失败不能阻塞轮次，且该选择会继续等待之后被接受的轮内 pre-step。追加用户选择时还会记录一条插件来源的 `user/message` 通知，但仅当最后记录的请求头描述的是另一种状态时才记录，因此模型恰好在上下文变化时收到通知，且绝不重复。在某轮最后一个被接受的 pre-step 之后作出的选择只存在于进程内；如果进程在另一个被接受的轮内 pre-step 之前退出，该选择会丢失（[README 限制](../../packages/debug/debug-mode/README.zh.md#known-limitations-and-deferred-work)）。

## 配置

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

`prompt` 缺失、为空白或不是字符串，以及任何未知键，都会在插件加载时失败，而不是被忽略。调试模式激活期间，确切的 `prompt` 文本以 order 550 渲染为 `debug:policy` [系统提示词段落](system-prompt.zh.md)；未激活的调试模式不贡献任何文本。

## `finish_debug` 工具与 `/debug` 命令

当 [`ctx.commands`](commands.zh.md) 被组合时，插件注册 `/debug <issue>` 与 `/debug off`。`/debug <issue>` 要求携带 issue，先选择调试模式，再通过 `agent.steer()` 提交所报告的 issue（连同任何附加的图片或文件），使其在 `debug:policy` 指引下成为下一步骤的普通已记录用户消息；工作流提示词本身不会被注入该消息。确切参数 `off` 选择未激活，这还会在待生效条目被追加并对请求可见之前将其取消。空 issue 在轮次开始前被拒绝。

[`finish_debug`](../tool-catalog.zh.md#deepseek-aidsh-debug) 保持在面向模型的工具目录中，因此进入或离开调试模式不增加工具目录的改动；它只在调试会话期间有意义。它接收以有序列表形式提供的复现该 issue 的步骤（仅此而已），并通过[用户交互 seam](user-questions.zh.md) 阻塞，直到活跃 UI 回答 **Proceed**（继续）或 **Mark as fixed**（标记已修复）。**Proceed** 使会话保持调试模式，并把当前周期捕获的日志条目（自上一次判定或模式条目以来端点接受的条目）作为工具结果返回。**Mark as fixed** 记录一个静默（不叙述）的待生效退出，由下一个被接受的轮内 pre-step 追加。因此，指引在 assistant 当前这批工具调用的剩余部分继续生效，而工具结果本身会报告这次转换。判定作为工具结果交付给模型——而不是单独 steer 的消息——因此「模型可见 ⟺ 已记录」规则成立，且不需要新的会话事件。被拒绝的审阅、缺失的交互通道，以及审阅期间的服务重载，都会使调用失败，而不是静默继续。

## 服务

`ctx.debug` 拥有已记录的调试状态，在步骤开始时应用并叙述选中的状态，还拥有 `debug:policy` 段落、回环 debug-log 端点、`/debug` 命令和稳定注册的 `finish_debug` 工具；`get`/`set` 签名见生成的[服务目录](#ctxdebug--debugmodecontroller)。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Agent](core.zh.md)

Source: [`packages/debug/debug-mode/src/index.ts`](../../packages/debug/debug-mode/src/index.ts)
<!-- END GENERATED cordis-surface -->
