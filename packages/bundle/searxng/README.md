---
description: "Optional bundle that re-points the web seam's search to a keyless, self-hosted SearXNG instance."
kind: "package-bundle"
---

# @deepseek-ai/dsh-searxng

English | [中文](README.zh.md)

## Summary

`dsh-searxng` is the optional bundle that swaps the web seam's search provider from the shipped DeepSeek-official backend to a keyless, self-hosted [SearXNG](https://docs.searxng.org) instance. Enabling it for a profile makes `web_search` go through your own SearXNG — no API key, no external service account, and the instance's upstream engines stay under your control. The bundle is a patch-only layer over the composition's base `web` row; nothing else about the profile's contract changes.

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

### Enabling the bundle

The Web GUI lists the bundle on the Plugins page of a profile (Official group, marked by a magnifying-glass icon); toggling it on selects the bundle for that profile. For a CLI profile, run `dsh plugin --profile <name> add @deepseek-ai/dsh-searxng`; disabling or removing the bundle restores the shipped search backend.

### Pointing at your instance

The provider reads the instance base in this order: the `baseURL` config field, then `$SEARXNG_BASE_URL` from the launch environment, then `http://localhost:8028`.

```yaml
# profile patch (or the SEARXNG_BASE_URL environment variable)
- id: web-search-searxng
  config:
    baseURL: http://localhost:8028
    categories: general,news
```

On the instance side, SearXNG must answer the JSON API:

```yaml
# SearXNG settings.yml (instance side)
search:
  formats:
    - html
    - json
```

### What you get

The selected profile's one-shot or Web contract is inherited unchanged. The only difference is the `web_search` backend: sources come from SearXNG's `results[]` with `title`, `content` as snippet, and `publishedDate`, and no generated answer is returned.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The bundle carries no runtime code; its substance is `cordis.patch.yml`, declared by the `dsh.bundle.patch` manifest field.

### Patch over the base web row

The layer applies after `dsh-base` in any composition that carries the base `web` row and makes two changes:

- It re-points the base `web` row at the keyless backend: `searchProvider: searxng` (restating the row's `fetchProvider: http`, because a patch replaces the targeted row's whole config).
- It inserts the [`@deepseek-ai/dsh-web-search-searxng`](../../web/web-search-searxng/README.md) plugin, which registers the `searxng` search provider with `ctx.web`.

`OPTIONAL_BUNDLES` in [`app-boot`](../../boot/app-boot/README.md) names this package and `apps/cli` depends on it, so every installation ships it switched off and the plugin manager offers it in the Official group. Selecting it appends the bundle to the profile's `dsh.profile.bundles` list. No runtime invariant companion is published because this configuration-only package owns no mutable runtime state; the observable contract (SearXNG-served `web_search`) is covered by the profile composition tests and the loader-smoke e2e.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Re-points the `web` row to the SearXNG search provider and mounts the provider |
| [`src/index.ts`](src/index.ts) | Marker module; no runtime API |
| [`icon.svg`](icon.svg) | Plugin-manager icon |
| [`locale/en.json`](locale/en.json), [`locale/zh.json`](locale/zh.json) | Plugin-manager title and description |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when you want to go deeper into the bundle or the backend it selects.

- [Bundle package map](../README.md) — the profile bundles and their layers.
- [Shipped optional bundles note](../../../.agents/notes/implemented/process/2026-09-15-shipped-optional-bundles.md) — how optional bundles ship switched off and get selected.
- [dsh-base](../base/README.md) — the shared core the bundle re-points.
- [dsh-headless](../headless/README.md) — the one-shot runner the bundle most often rides on.
- [dsh-web-search-searxng](../../web/web-search-searxng/README.md) — the keyless SearXNG provider this layer selects.
- [Web subsystem](../../../docs/subsystems/web.md) — the search request/result vocabulary and error codes.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the composed base, headless, and web-search-searxng packages, which own the request prefix, the `web_search` schema, and the SearXNG-sourced results.

#### KV Cache effect

The bundle itself adds no request prefix; a different search backend changes tool results, not the request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits tell you when the bundle does not fit. They are current package constraints.

- **You run the SearXNG instance** — the bundle is keyless only because it is self-hosted; without a reachable instance on the configured base URL, every `web_search` fails with `WEB_PROVIDER_ERROR`.
- **The instance must enable the JSON format** — without `search.formats: [json]`, every search returns an HTML page and fails.
- **The limiter may reject requests** — local instances can answer 403/429 for bot-like traffic; tune `search.limiter` or the instance's bot-detection settings.
- **No generated answer** — SearXNG returns aggregated results, not a synthesized response, so `web_search` output is sources only.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
