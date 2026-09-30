# Agent Note: 已记录调试模式

Status: implemented

[English](2026-09-16-logged-debug-mode.md) | 中文

## Problem

调试模式最初以一次性无状态（[one-shot debug mode](2026-09-10-one-shot-debug-mode.zh.md)）交付，它的两个接缝暴露了这一点。工作流提示词被 steer *进用户消息*、与报告的 issue 并列，于是调试会话的定义性文本活在用户可见的对话内容里——它泄漏进会话标题以及其他一切从用户消息派生的东西，而且每次 `/debug` 都把整段工作流提示词重新注入历史，仿佛用户亲自输入了它。另一方面，一次性流程没有任何已记录状态：客户端无从知道会话正在调试，于是除了输入 `/debug off` 之外，既没有查看该模式的入口，也没有离开的入口，而恢复或 fork 会彻底丢失这一上下文。

plan mode 的镜像被拒绝作为*第一版*设计，是因为一次调试会话看起来像一个没有持久立场的循环；而产品层面的真实需求恰好相反——一个用户能查看、能进入、能离开的模式，与 plan mode 相同。

## Decision

调试模式是逐 agent（智能体）的已记录状态，与 [plan mode](../../../../docs/subsystems/plan.zh.md) 完全一致，由 `@deepseek-ai/dsh-debug`（`packages/debug/debug-mode/`，`ctx.debug`，`DebugModeController`）拥有。

- `debug/mode`（`{ active: boolean }`）是仅记日志、整值替换的[会话事件](../../../../docs/subsystems/session.zh.md)；该新增事件无需提升 `SESSION_FORMAT_VERSION`。`debug` 投影单元把它与命令结算结果、以及最近一次请求头记录的模式一起折叠；客户端接收裁剪后的 `{ active, pending, logs }` 视图，新的 `ui-debug` 包将其渲染为红色的输入框徽标，执行 `/debug off`。
- 日志捕获从模型写入的 `debug.txt` 文件改为回环 debug-log 端点。服务在其生命周期内监听 `http://127.0.0.1:<port>/debug/<sessionId>`（`debug_log_url` 提示词变量解析该 URL，使 `debug:policy` 提示词能够指名它），仅在会话模式激活时接受 `{ step, at, data? }` 条目（JSON 对象或 NDJSON），并把每个被接受的条目追加为仅记日志、保序的 `debug/log` 事件。投影把当前周期的条目保留在一个滑动窗口内（4,000 条 / 256,000 字符，按 `step + JSON.stringify(data)` 计）；模式变更或一次成功的 `finish_debug` 以一个空窗口开启新周期，而一次失败的 `finish_debug` 保留它。该窗口是 finish 工具的来源：**Proceed** 读取它并把条目作为工具结果返回，当窗口为空时工具返回一条未捕获说明（判定仍为 `reproduced`），于是模型可以要求用户重新运行或修复插桩。
- 部署方 `prompt` 不再被 steer。它渲染为 `debug:policy` [系统提示词段落](../../../../docs/subsystems/system-prompt.zh.md)，位于 first-party order 550（介于 `PLAN_POLICY` 500 与 `TEAM_POLICY` 600 之间），仅在模式激活或有进入选择待生效时可见——于是用户消息（以及从用户消息派生的一切，最典型的是会话命名）只携带所报告的 issue。
- `/debug <issue>` 选择激活并 steer 该 issue（连同任何已准入的附件）为下一条普通用户消息；`/debug off` 选择未激活并取消待生效条目。两者都遵循 plan mode 的 `set()` 结算：轮次之间 `committed`、轮内 `queued` 并在 pre-step 追加、`cancelled` 或 `noop`，附标准的「上一次请求头描述了另一种模式时才叙述」的用户切换通知。
- `finish_debug` 保持其形态与「判定作为工具结果」的交付方式。它接收以有序列表形式提供的复现该 issue 的步骤（仅此而已，不含叙述、也不含「应查看什么」的说明），因此审阅卡片只显示用户必须运行的复现步骤。**Proceed** 使会话保持调试模式，并把当前周期捕获的日志条目作为工具结果返回。**Mark as fixed** 记录一个静默（不叙述）的待生效退出，由下一个被接受的轮内 pre-step 追加——与 plan mode 批准的退出同一种延迟——于是会话随修复结束，徽标随之消失。
- 审阅接管（plan review、debug review）通过 `ui-user-questions` 中的一张共享决策卡片（`ReviewCard` 与 `useReviewCard` 行为 hook）渲染，两张卡片共享标记与行为而无重复组件；每个面板保留自己的 CSS module、身份属性与文案。debug 卡片像调试模式徽标一样染成红色（error/danger token），以区别于中性的 plan review 卡片。

`{ prompt: string }` 配置契约与审阅边界（被拒绝 = 等待的失败调用；缺失通道与服务重载大声失败）从一次性说明原样承继；它们所描述的日志捕获机制是回环 debug-log 端点，由本说明拥有。

## Alternatives considered

**保留一次性流程，只修提示词位置。** 把提示词移到系统段落但不引入已记录状态，客户端仍然无法显示或退出该模式，且该段落没有逐 agent 状态可以挂靠；模式状态是更廉价也更完整的答案。

**仅客户端的模式标志（无会话事件）。** 状态无法跨恢复与 fork 存活，无法通过日志到达模型，且政策段落一旦依赖状态就立即破坏「模型可见 ⟺ 已记录」规则。

**复用 `PLAN_POLICY` 的 order 或更高的槽位。** order 550 让调试指引在提示词中与计划指引相邻，同时保持一个由 `SECTION_ORDERS` 门禁保证的独立 first-party 槽位。

## Consequences

调试会话在状态层面现在与 plan 会话一致：持久、可跨恢复与 fork 恢复、客户端通过投影可见、且每次真正的上下文变化恰好叙述一次。代价是 plan mode 所付的同一套机制——日志事件（`debug/mode` 与 `debug/log`）、一个投影单元、一个 pre-step 监听器、一个提示词段落，外加回环 debug-log 端点——再加 `ui-debug` 徽标包。进入或离开会从 order 550 起改变请求前缀，激活模式把配置的 prompt 加入每个请求。在某轮最后一个被接受的 pre-step 之后作出的待生效选择只存在于进程内，进程退出即丢失，这是 plan mode 同样携带的限制。一次性说明保持激活并带一条被取代指针：它所作且本次未反转的决策（判定作为工具结果、审阅失败边界、固定配置）仍以其为家；取代 `debug.txt` 修复时截断的逐周期日志重置见上文。
