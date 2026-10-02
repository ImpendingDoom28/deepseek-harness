---
description: "The keyless SearXNG-backed search provider for ctx.web: how deployments mount a local SearXNG instance as a search backend with no API key."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-searxng

English | [中文](README.zh.md)

## Summary

With `dsh-web-search-searxng`, the harness searches the web through a locally run SearXNG instance — no API key, no external service account. It returns citeable sources in one call, without a generated answer: the metasearch engine aggregates your configured upstream engines, and the harness passes their results through as `sources[]`. SearXNG exposes no result-count control on the wire, so the returned sources are truncated to the requested bound after the fact. When an engine omits a result's metadata, sources fall back to URL-only citations. The model-facing `web_search` tool lives in `dsh-tool-web`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the provider in a composition that already loads the web service; it registers as the `searxng` search provider, so `ctx.web.search()` resolves it automatically when it is the only usable search backend — or pin it with `searchProvider: searxng`. The optional [`dsh-searxng`](../../bundle/searxng/README.md) bundle does exactly this for a selected profile: it re-points the base `web` row to `searchProvider: searxng` and inserts the provider.

### When to choose it

Choose this backend when a deployment runs (or can run) its own SearXNG instance and wants keyless, self-hosted web search. The provider is unavailable — and every search call fails with a structured error — when the endpoint base does not parse or a configured category list is blank.

### Minimal configuration

Load the web service and the provider; the instance base falls back to `$SEARXNG_BASE_URL` from the launch environment, then to `http://localhost:8028`. SearXNG must have its JSON format enabled on the instance side:

```yaml
# SearXNG settings.yml (instance side)
search:
  formats:
    - html
    - json
```

```yaml
# cordis.yml (harness side)
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-searxng'
  config:
    baseURL: !!js process.env.SEARXNG_BASE_URL
```

| Field | Default | Meaning |
|---|---|---|
| `baseURL` | `$SEARXNG_BASE_URL`, then `http://localhost:8028` | Instance base; `/search` is appended. An unparseable value makes the provider unavailable |
| `categories` | (unset) | Comma-separated SearXNG categories (for example `general,news`), sent as the `categories` parameter. Unset uses the instance default |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-searxng) is the exhaustive source for every accepted field and its JSDoc.

### What a search returns

`sources[]` is built from SearXNG's `results[]`: `url`, `title` when present, `content` as `snippet` when non-blank, and `publishedDate` as `publishedAt`. Results without a URL are dropped, and a blank `content` yields a URL-only citation rather than an invented snippet. SearXNG returns no generated answer, so `content` is always absent, and the service enforces `maxResults` by truncating and flagging.

### Failures and recovery

Provider failures — HTTP errors (including the limiter's 403/429), network failures, unparseable or wrong-shape bodies — surface as `WebError` `WEB_PROVIDER_ERROR`; an aborted request surfaces as `WEB_ABORTED`. HTTP redirects are rejected before the `Location` target is contacted and surface as `WEB_PROVIDER_ERROR`. A 404 or an HTML body usually means the JSON format is not enabled on the instance. Callers route on the code; the model-facing `web_search` tool surfaces failures to the model under its own error wrapper.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The provider is a thin adapter over SearXNG's JSON search endpoint with two deliberate rules:

- **No generated answer.** SearXNG aggregates upstream engines and returns their raw results, so the provider omits `content` and carries only `sources[]` into the seam.
- **Engine metadata is pass-through, not invented.** Each wire field maps to its seam counterpart when present; absent or blank fields are omitted rather than filled, which is why `title`/`snippet`/`publishedAt` stay optional on the service.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, environment fallback, provider registration |
| [`src/provider.ts`](src/provider.ts) | The `SearxngSearchProvider`: request dispatch, abort classification, result mapping |
| [`src/types.ts`](src/types.ts) | SearXNG wire types for the search response |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |

### Request and mapping flow

`search()` sends `GET {baseURL}/search` with `format=json`, the query, and the optional categories, with `redirect: 'error'`. The response's `results[]` becomes `sources[]` through the field mapping above, and the service applies the final `maxResults` bound on the way back. An abort — a `DOMException` named `AbortError` — becomes `WEB_ABORTED`; anything else becomes `WEB_PROVIDER_ERROR`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared vocabulary to the service, the model-facing tools, and the design rationale.

- [Web subsystem](../../../docs/subsystems/web.md) — the exhaustive search request/result vocabulary and error codes.
- [Web package map](../README.md) — the package family and each role.
- [dsh-web](../web/README.md) — the web service this provider registers into.
- [dsh-tool-web](../tool-web/README.md) — the model-facing `web_search` tool that renders this provider's sources.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-searxng) — every accepted config field and its source declaration.
- [Web capability seam decision](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md) — why search and fetch share one provider-selection service.

-----

<a id="model-experience"></a>
## Model Experience

### Auxiliary SearXNG request

#### What the model sees

A separate SearXNG request carries `<query>` verbatim to the instance's search endpoint. This request is not part of the conversation model's context.

#### Token effect

No model tokens are incurred by the provider itself; the instance's upstream engines do their own processing.

#### KV Cache effect

Independent of the conversation request cache; no model cache is involved.

### Conversation tool result, indirectly

#### What the model sees

Through `dsh-tool-web`, the conversation model sees the sources with their titles, snippets, and URLs. This provider's exact failures are `SearXNG search aborted`, `SearXNG search request failed: <error>`, and `SearXNG returned an unprocessable response body: <error>`; HTTP failures preserve the provider message. The consumer owns the error wrapper.

#### Token effect

Zero direct conversation tokens from registration. Source tokens are data-dependent, source count is instance-bounded, and the retained result or error is resent until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is a poor fit. They are current package constraints.

- **The instance must enable the JSON format** — without `search.formats: [json]` in SearXNG's settings, every search returns an HTML page and fails with `WEB_PROVIDER_ERROR`.
- **The limiter may reject the request** — local instances can answer 403/429 for bot-like traffic; the error carries the instance's message, and tuning `search.limiter` or the instance's `botdetection` settings recovers it.
- **Over-returned sources still cost tokens and latency** — with no result-count control on the wire, `maxResults` is enforced only post-hoc by service truncation, and the instance returns its full configured page size.
- **Engine metadata varies per result** — `title`, `snippet`, and `publishedAt` are per-engine, so sources from some engines render as bare URL-only citations.
- **Abort classification is error-shape-based** — only a `DOMException` named `AbortError` maps to `WEB_ABORTED`; an abort carrying a custom reason (such as `dsh-timeout`'s `TimeoutReason`) surfaces as `WEB_PROVIDER_ERROR`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above and the linked Agent Notes.

#### Future: wider SearXNG control surface

SearXNG's other search controls (language, time range, safe-search level, `engines` selection) stay unexposed. Exposing them needs provider-neutral service fields first, so the family adds one coordinated control rather than a vendor-specific argument.

</details>
