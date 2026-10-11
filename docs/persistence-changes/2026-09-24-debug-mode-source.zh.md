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
    previous: "2026-10-05-working-directory-attribution"
    after: "311167d31187079b87f5eac46a3a2eff0ece3608be99d29679db3ef0c2b62208"
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
    previous: "2026-10-05-working-directory-attribution"
    after: "ffebb8b7f1c1f2bc53bf7a70edc460f5c80fbd5d2aeedb7012963fa8b4556da1"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-07-title-reasoning-effort"
    after: "a55bdac0e6df59db90106eae01c5dde0d78ebfe68c4ef9392159634b7f4cea11"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-05-working-directory-attribution"
    after: "0c862a7fcfcbc2cbef27c1bc0b29b60bc97322d89bb12f4080e135005589a877"
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
