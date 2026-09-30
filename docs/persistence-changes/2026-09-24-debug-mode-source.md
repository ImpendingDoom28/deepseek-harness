---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-24-debug-mode-source

English | [中文](2026-09-24-debug-mode-source.zh.md)

## Summary

Adds the debug-mode message source and the two debug session events (debug/mode and debug/log) for the dsh-debug plugin.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing logs contain no debug-mode source and no debug events, and remain valid. The debug-mode source is qualified attribution on an ordinary user message: readers without dsh-debug preserve the message and derive history from its content; no projection reads the kind. The two new events are log-only, non-surface, and ignorable: a build that does not know them refuses the log unless the envelope carries ignorable, and the debug projection is the only reader. No Session header or existing event type changes.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/debug/debug-mode/tests: 67 tests passed. pnpm run typecheck passed. pnpm run verify-persistence-changes passed.

<a id="dev-note"></a>
## Dev Note

None.
