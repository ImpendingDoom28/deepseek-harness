---
description: "Package map for the debug group: the logged debug mode that investigates an issue, instruments it through the loopback debug-log endpoint, and reviews the captured logs with the user, for users and maintainers navigating the group."
kind: "package-group"
---

# debug/ — 记录到日志的调试模式

[English](README.md) | 中文

## 摘要

`debug/` 组提供记录到日志的逐 agent（智能体）调试模式：你用 `/debug <issue>` 报告 issue（问题），agent 调查它、添加把日志条目 POST 到回环 debug-log 端点的临时插桩（instrumentation），然后把复现该 issue 的步骤交给你。你回答 **Proceed**（继续——已复现，它保持该模式并把捕获的条目作为工具结果接收）或 **Mark as fixed**（标记已修复——它移除插桩并保留修复，结束会话）。该模式与捕获的条目都能从会话日志在恢复、fork 与压缩（compaction）中恢复；`/debug off` 使其未激活。该组只有一个包，`debug-mode`。

## 目录

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

一个包提供整个调试模式；子系统参考拥有共享词汇。

| Package | Role | ctx key |
|---|---|---|
| [`debug-mode/`](debug-mode/README.zh.md) | 提供记录到日志的调试模式：`/debug` 激活它，agent 插桩回环 debug-log 端点，`finish_debug` 把复现步骤交给你做 Proceed / Mark-as-fixed 审阅 | `ctx.debug` |

-----

<a id="related-documentation"></a>
## Related documentation

先从子系统参考了解共享词汇，再读包 README 了解配置与模型体验。

- [调试模式子系统参考](../../docs/subsystems/debug.zh.md) — 回环 debug-log 端点、`finish_debug` 审阅流程与 `/debug` 命令。
- [用户交互子系统](../../docs/subsystems/user-questions.zh.md) — `finish_debug` 为 Proceed / Mark-as-fixed 判定阻塞其上所用的 seam。

<a id="dev-note"></a>
## Dev Note

无。
