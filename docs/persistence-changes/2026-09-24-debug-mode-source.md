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
## Compatibility

Existing logs contain no debug-mode source and no debug events, and remain valid. The debug-mode source is qualified attribution on an ordinary user message: readers without dsh-debug preserve the message and derive history from its content; no projection reads the kind. The two new events are log-only, non-surface, and ignorable: a build that does not know them refuses the log unless the envelope carries ignorable, and the debug projection is the only reader. No Session header or existing event type changes.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/debug/debug-mode/tests: 67 tests passed. pnpm run typecheck passed. pnpm run verify-persistence-changes passed.

<a id="dev-note"></a>
## Dev Note

None.
