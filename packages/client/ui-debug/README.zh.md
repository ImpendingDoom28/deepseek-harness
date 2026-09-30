---
description: "Web GUI 的调试模式状态徽章：显示调试模式已开启并可将其关闭的 composer 控件；供调试模式的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-debug

[English](README.md) | 中文

## 概述

本包在 Web GUI 中渲染调试模式状态徽章：当宿主计算的投影有效目标为调试模式时，composer 显示一个红色的「Debug ×」按钮，可关闭调试模式；否则该座位保持为空。调试模式本身——`/debug` 命令、已提交的 `debug/mode` 状态、投影单元与 policy 段——归 `dsh-debug` 所有；本包只渲染投影并发送用户同样可以手敲的内容。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

与 `ui-conversation` 及 `dsh-debug` 一起挂载本插件；调试模式激活时，徽章随即占据 composer 的 debug 座位（紧邻 plan 控件）。经 `/debug <issue>` 命令路径进入调试模式——从 composer 的 `+` Command 菜单选择 Debug，或键入 `/debug`——再用徽章将其关闭。通过 `finish_debug` 将问题标记为已修复同样会结束该模式，因此徽章会随解决一同消失。

### 徽章显示什么

当有效目标为调试模式时，该座位渲染红色的「Debug ×」状态按钮，执行 `/debug off`。否则座位保持为空：未组合 debug-mode 的宿主，或尚无会话的 Draft，都不显示任何内容。

### 失败

准入失败（`matched: false`、业务错误、传输故障）以内联错误呈现，徽章保持显示直至投影确认退出。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

徽章占据 conversation 声明的 `conversation.input.debug` 单实例座位；node 半部是空 apply（roster 行）。读取经 standard-kit 的 `useProjection` 走通用投影对：有效目标是 `pending ? !active : active`——折叠的宿主值而非客户端乐观态，因此到达的帧无论哪个方向都会纠正徽章。座位注入面携带一个动词 `exitDebugMode`，经 `ctx.remote.commands.execute` 执行 `/debug off`，并把准入失败映射为一行内联错误。徽章文案位于本包的 `debug` locale 命名空间。无障碍描述是「Debug mode on, press to turn off」。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当调试 surface 不够用时阅读以下页面。它们从徽章进入调试模式领域与 composer 外壳。

- [dsh-debug](../../debug/debug-mode/README.zh.md)——拥有调试模式、`/debug` 命令、投影与 policy 段。
- [ui-conversation](../ui-conversation/README.zh.md)——声明 composer 的 `conversation.input.debug` 座位。
- [客户端包映射](../README.zh.md)——相邻的浏览器 UI 包。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过徽章派发的 `/debug off` 命令行：`dsh-debug` 拥有该命令行驱动的模型可见 policy 段与已记录状态。

#### KV Cache 影响

进入或离开调试模式会改变活跃的 `debug:policy` 系统提示词段，因此改变请求前缀；徽章本身不添加任何提示词内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了当前调试徽章。它们是当前包约束，不是调试模式对比或任务积压。

- **调试模式是引导而非执行沙箱**——需要强制限制的部署必须组合独立的沙箱与审批策略。
- **徽章属于默认 composer**——待处理的涉及整个 composer 的交互（如调试评审）会临时取代 InputBar 及其徽章。
- **未激活时无调试控件**——入口使用共享 Command source；有能力但模式未激活的会话在工具行不显示调试入口。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。调试 state 与 boundary 的所有权由 dsh-debug 审计；本包的 control 是一种 slot effect，其声明、注册与清理由本包执行。
