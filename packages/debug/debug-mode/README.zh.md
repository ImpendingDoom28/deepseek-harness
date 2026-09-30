---
description: "Logged debug mode for users and maintainers choosing, configuring, or debugging the per-agent debug state: a deployment-owned prompt section, a loopback debug-log endpoint, a /debug command, and a user-reviewed finish_debug that returns the captured log entries on Proceed and ends the mode on Mark-as-fixed."
kind: "package-reference"
---

# @deepseek-ai/dsh-debug

[English](README.md) | 中文

## 概述

调试模式把报告的 issue（问题）变成一个假设驱动的循环：`/debug <issue>` 启动它，agent（智能体）检查代码、定义 5 个假设，并通过临时插桩（instrumentation）把每个假设的证据 POST 到回环 debug-log 端点，然后把复现该 issue 的步骤交给你。**Proceed**（继续，已复现）保持该模式并返回捕获的日志条目；agent 修复被证实的假设、跳过被否决的假设，并在没有任何假设被证实时重新插桩。**Mark as fixed**（标记已修复）移除插桩、保留修复并结束会话。它是与[计划模式](../../plan/plan-mode/README.zh.md)相同的逐 agent（智能体）记录的已记录状态：它在恢复与 fork（分叉）后仍然存在。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

常见路径：配置工作流提示词，用 `/debug` 启动调试会话，然后以 Proceed 或 Mark as fixed 回答 `finish_debug` 审阅。

### When to choose it

当 agent 应调查报告的 issue、在确定修复前通过 debug-log 端点收集证据、并把复现步骤交给你时，选择调试模式。它不限制 agent：每个工具保持可调用，因此强制限制请使用沙箱模式与审批提示。当 agent 可以立即诊断并修复、无需一轮收集与审阅时，跳过它。

### Minimal configuration

唯一的必需配置是每次会话中 agent 遵循的工作流提示词；你添加的任何其他内容都会在加载时失败。

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
| `prompt` | required | 调试工作流提示词，在调试模式激活期间渲染为 `debug:policy` 提示词段落 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-debug)是所有接受字段及其 JSDoc 的完整来源。

<a id="the-debug-command"></a>
### The `/debug` 命令

输入 `/debug <issue>` 启动会话：issue 文本是必需的；它先选择调试模式，再连同任何附加的图片或文件一起被 steer 为你的下一个请求，处于 `debug:policy` 指引下（工作流提示词本身不会被注入该消息）。输入 `/debug off` 离开：选择从下一步开始生效，会话在轮次之间时则立即生效，尚未追加的待生效条目会被取消。空 issue 在轮次开始前被拒绝。该命令在任何支持斜杠命令的地方都可用，例如 Web 客户端，激活的模式还会显示红色的 **Debug** 徽标。

<a id="the-finish-debug-review"></a>
### The `finish_debug` 审阅

当 agent 已添加插桩后，它调用 `finish_debug` 携带复现该 issue 的步骤（有序列表，仅此而已，不含叙述、也不含「应查看什么」的说明）。你审阅这些步骤，然后选择 **Proceed**（继续——issue 已复现；会话保持调试模式，agent 把捕获的日志条目作为工具结果接收）或 **Mark as fixed**（标记已修复——issue 已解决；agent 移除插桩并保留修复，会话离开调试模式）。当没有捕获到任何条目时，agent 会被告知未捕获到条目，于是它可以让你重新运行步骤或修复插桩。关闭审阅改为输入一条消息，则告诉 agent 保留插桩并等待你的消息。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

该包是一个已记录模式（logged-mode）控制器，镜像[计划模式](../../plan/plan-mode/README.zh.md)。它注册稳定的 `finish_debug` 工具和 `debug:policy` 提示词段落（仅在激活期间渲染，感知待生效状态），并且在 `ctx.commands` 被组合时注册 `/debug` 命令。调试状态是仅记日志的 `debug/mode` 与 `debug/log` 事件，由注册的 `debug` 投影单元折叠；`ctx.debug.get`/`set` 暴露已记录或待生效的状态，前置的 `agent/pre-step` 监听器在下一个请求组装之前追加待生效选择，并附标准的用户切换通知。`finish_debug` 在[用户交互 seam](../../../docs/subsystems/user-questions.zh.md) 上阻塞，等待其 Proceed / Mark-as-fixed 判定，并把判定作为工具结果交付，从而无需新的会话事件就保持「模型可见 ⟺ 已记录」规则完整。回环 debug-log 端点是进入 `debug/log` 的唯一路径：服务在其生命周期内于 `http://127.0.0.1:<port>/debug/<sessionId>` 监听它（`debug_log_url` 提示词变量解析该地址），仅在会话模式激活时接受 `{ step, at, data? }` 条目，并把每个被接受的条目追加为 `debug/log` 事件。投影把当前周期的条目保留在一个滑动窗口内（4,000 条 / 256,000 字符），且模式变更或一次成功的 `finish_debug` 会开启新周期。当你选择 Proceed 时，finish 工具读取该窗口并把条目作为工具结果返回；当没有捕获到任何条目时，它返回一条未捕获说明而不是一次失败的调用。

| File | Responsibility |
|---|---|
| `src/index.ts` | `DebugModeController`：已记录状态、`debug:policy` 段落、回环 debug-log 端点、`/debug` 命令与 `finish_debug` 工具 |
| `src/types.ts` | `DebugProjection`、`DebugUnitState`，以及 `debug` 投影 key 的合并 |
| `src/client.ts` | 投影视图类型的 `./client` 导出 |
| — | 未发布运行时不变量（invariant）伴生文件；已记录的 `debug/mode` 与 `debug/log` 事件是唯一事实来源，投影对它们做确定性折叠，因此没有需要守卫的分叉观察。 |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [调试模式子系统参考](../../../docs/subsystems/debug.zh.md) — 已记录状态、回环 debug-log 端点与 `/debug` 命令。
- [用户交互子系统](../../../docs/subsystems/user-questions.zh.md) — `finish_debug` 为判定阻塞其上所用的 seam。
- [计划模式包](../../plan/plan-mode/README.zh.md) — 调试模式所遵循的模式：逐 agent 的已记录状态、政策段落，以及把判定作为工具结果交付的审阅式退出。
- [ui-debug 包](../../client/ui-debug/README.zh.md) — Web 输入框中显示并关闭激活模式的徽标。
- [添加一个工具](../../../docs/cookbook/adding-a-tool.zh.md) — `finish_debug` 卡片与展示器如何设计。

-----

<a id="model-experience"></a>
## Model Experience

### Debug policy system prompt

#### What the model sees

调试模式激活期间，模型在 first-party 提示词 order 550 看到部署方确切的 `prompt` 文本；未激活模式不贡献任何文本。待生效的进入选择被视为激活，因此该段落从选择之后的第一个请求起渲染，即便日志追加尚未落地。

##### Configuration example

```markdown
You are in a debug session. Investigate the issue, add temporary
instrumentation that POSTs the relevant state to the debug-log endpoint
at {{debug_log_url}}, and call finish_debug with the steps to
reproduce the issue as an ordered list.
```

#### Token effect

未激活模式不增加 token；激活模式把配置的 prompt 加入每个请求。

#### KV Cache effect

prompt 在调试模式内部稳定，但进入或离开会改变 first-party order 550 起的系统提示词。

### Human command

#### What the model sees

`/debug <issue>`、`/debug off` 及其终端结果都留在模型历史之外。所报告的 issue 在选择调试模式之后，通过 `agent.steer()` 成为一条用户消息：按选择顺序的已准入图片与文件块，然后是裁剪后的 issue 文本。工作流提示词从不进入该消息。被叙述的激活或未激活用户选择，仅当上一次请求头描述的是另一种模式时，才贡献标准的已记录用户切换通知；取消一个尚未被请求观察到的待生效条目不贡献任何通知。

#### Token effect

issue 消耗与单独提交该内容相同的历史 token；prompt 本身在激活期间由系统提示词承载。被叙述的切换追加一条小的保留切换通知。

#### KV Cache effect

用户消息是只追加的会话增长。进入或离开调试模式改变更早的政策段落；被叙述的切换通知追加在可复用的请求前缀之后。

### The `finish_debug` schema and review exchange

#### What the model sees

[`finish_debug` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-debug) 在两种状态中都保持可用，因此进入或离开调试模式不增加工具目录改动；该工具只在会话期间有意义。**Proceed** 把复现说明返回给模型（当没有捕获到任何日志条目时返回未捕获变体），会话保持调试模式。**Mark as fixed** 返回已修复说明并结束会话：指引在 assistant 当前这批工具调用的剩余部分保持激活，静默退出由下一个被接受的轮内 pre-step 追加，因此不记录单独的切换通知。被拒绝的审阅是一次指明用户接管的失败调用。

#### Token effect

稳定的 schema 按 ToolRuntime 模式计费，且每次 `finish_debug` 调用及其判定都留在会话历史中。

#### KV Cache effect

模式切换不改变工具目录；判定按常规延长会话，静默退出在下一步改变更早的政策段落。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

这些限制描述调试模式在何时不按你预期的行为工作、或需要额外注意。它们是当前包约束，不是路线图。

- **日志窗口有上限** — 投影每个周期至多保留 4,000 条或 256,000 字符，超出任一上限的 POST 被拒绝（429）；超过 1 MiB 的 body 同样被拒绝（413），因此长会话只保留窗口内最新的条目。
- **Proceed 从不校验日志** — 当没有捕获到任何条目时，判定（reproduced）仍然成立并附一条未捕获说明，因此模型必须重新运行步骤或修复插桩。
- **仅一个专用审阅渲染器** — 只有 Web UI 有 `debug-review` 呈现；其他交互提供方通过其通用选项流程呈现同一请求。
- **待生效选择只存在于进程内** — 在某轮最后一个被接受的 pre-step 之后作出的选择，若进程在另一个被接受的轮内 pre-step 之前退出，该选择会丢失，与计划模式同类。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放的设计问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文、包代码和相关 Agent Note 为准。

无。

</details>
