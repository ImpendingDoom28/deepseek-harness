---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-24-debug-mode-source

[English](2026-09-24-debug-mode-source.md) | 中文

## 概述

为 dsh-debug 插件新增 debug-mode 消息来源与两个调试会话事件（debug/mode 与 debug/log）。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-24-debug-mode-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-21-user-question-reply"
    after: "614e5fa60c54a17b10e3b170d2f258ada7adf0d28635cbda76bbedd3ed19e6a6"
    decision: same-version
  - root: "event:debug/log"
    previous: null
    after: "a8f28535144aa77d3222d66b50889860d245e1de10de8566f4bcec9b3abbcee8"
    decision: same-version
  - root: "event:debug/mode"
    previous: null
    after: "674427ac883664e28a9b8677d69eae812ef1cb0e476463629add37c5b079c83e"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-21-user-question-reply"
    after: "b04d1de6a265a7e0305dafa61bcf7ce510fa184f7780f5d7ec5b4df04e32a8fa"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-user-question-reply"
    after: "5dd7b9adf3f68d2742dc4aa82f0a4d5ed38c01e7b5d3d47121b985b7b4965540"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-21-user-question-reply"
    after: "be9148bbcb67203bd8c703bd7fb73d0c78b6293766766099741a9e34f511b544"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

现有日志不含 debug-mode 来源与调试事件，仍然有效。debug-mode 来源是普通用户消息上的带限定归因：没有 dsh-debug 的读取方保留消息并从其内容推导历史；没有投影读取该来源。两个新事件仅记录于日志、非 surface、可忽略：不含 ignorable 标记时，不知道这些事件的构建拒绝该日志；debug 投影是唯一读取方。Session 头与现有事件类型均无变化。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/debug/debug-mode/tests：67 项测试通过。pnpm run typecheck 通过。pnpm run verify-persistence-changes 通过。

<a id="dev-note"></a>
## 开发备注

无。
