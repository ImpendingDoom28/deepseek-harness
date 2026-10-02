---
description: "可选 bundle：把 web 缝（seam）的搜索改由无密钥、自托管的 SearXNG 实例提供。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-searxng

[English](README.md) | 中文

## 概述

`dsh-searxng` 是一个可选 bundle：它把 web 缝（seam）的搜索提供方从随箱的 DeepSeek-official 后端切换为无密钥、自托管的 [SearXNG](https://docs.searxng.org) 实例。为某个 profile 启用它之后，`web_search` 走你自己的 SearXNG——不需要 API 密钥，不需要外部服务账号，实例的上游引擎由你自己掌控。该 bundle 只是叠加在组合里 base `web` 行之上的纯补丁层；profile 契约的其他部分没有任何变化。

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

### 启用 bundle

Web GUI 在 profile 的 Plugins 页面列出该 bundle（Official 组，以放大镜图标标识）；打开开关即为该 profile 选中它。CLI profile 可运行 `dsh plugin --profile <name> add @deepseek-ai/dsh-searxng`；关闭或移除该 bundle 即恢复随箱搜索后端。

### 指向你的实例

提供方按以下顺序读取实例基址：`baseURL` 配置字段，然后是启动环境中的 `$SEARXNG_BASE_URL`，最后落到 `http://localhost:8028`。

```yaml
# profile patch (or the SEARXNG_BASE_URL environment variable)
- id: web-search-searxng
  config:
    baseURL: http://localhost:8028
    categories: general,news
```

在实例一侧，SearXNG 必须能应答 JSON API：

```yaml
# SearXNG settings.yml (instance side)
search:
  formats:
    - html
    - json
```

### 你得到什么

所选 profile 的一次性或 Web 契约原样继承。唯一的差别是 `web_search` 的后端：来源（sources）来自 SearXNG 的 `results[]`，携带 `title`、作为摘要（snippet）的 `content` 以及 `publishedDate`，不返回生成式答案。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

本 bundle 不携带运行时代码；它的实质是 `cordis.patch.yml`，由清单字段 `dsh.bundle.patch` 声明。

### 叠加在 base web 行之上的补丁

该层在携带 base `web` 行的任意组合中、`dsh-base` 之后应用，做两处改动：

- 把 base 的 `web` 行重新指向无密钥后端：`searchProvider: searxng`（同时重述该行的 `fetchProvider: http`，因为补丁会替换目标行的整个 config）。
- 插入 [`@deepseek-ai/dsh-web-search-searxng`](../../web/web-search-searxng/README.zh.md) 插件，它把 `searxng` 搜索提供方注册进 `ctx.web`。

[`app-boot`](../../boot/app-boot/README.zh.md) 中的 `OPTIONAL_BUNDLES` 列出了本包，且 `apps/cli` 依赖它，因此每个安装都随箱携带、默认关闭，由插件管理器在 Official 组中提供。选中它会把该 bundle 追加到 profile 的 `dsh.profile.bundles` 列表。不发布运行时 invariant 伴随模块，因为这个纯配置包不拥有可变运行时状态；其可观测契约（由 SearXNG 提供 `web_search`）由 profile 组合测试与 loader-smoke e2e 覆盖。

| 文件 | 角色 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 把 `web` 行改指向 SearXNG 搜索提供方，并挂载提供方 |
| [`src/index.ts`](src/index.ts) | 标记模块；无运行时 API |
| [`icon.svg`](icon.svg) | 插件管理器图标 |
| [`locale/en.json`](locale/en.json)、[`locale/zh.json`](locale/zh.json) | 插件管理器标题与描述 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当你想深入了解该 bundle 或它选用的后端时，阅读这些页面。

- [Bundle 包地图](../README.zh.md) —— 各 profile bundle 及其补丁层。
- [随箱可选 bundle 说明](../../../.agents/notes/implemented/process/2026-09-15-shipped-optional-bundles.zh.md) —— 可选 bundle 如何随箱关闭、如何被选中。
- [dsh-base](../base/README.zh.md) —— 该 bundle 重新指向的共享核心。
- [dsh-headless](../headless/README.zh.md) —— 该 bundle 最常承载的一次性 runner。
- [dsh-web-search-searxng](../../web/web-search-searxng/README.zh.md) —— 该层选用的无密钥 SearXNG 提供方。
- [Web 子系统](../../../docs/subsystems/web.zh.md) —— 搜索请求/结果词汇与错误码。

-----

<a id="model-experience"></a>
## 模型体验

间接通过所组合的 base、headless 与 web-search-searxng 包实现，这些包拥有请求前缀、`web_search` schema 与来自 SearXNG 的搜索结果。

#### KV Cache 影响

本 bundle 自身不添加请求前缀；不同的搜索后端改变的是工具结果，而不是请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制告诉你何时不适合使用该 bundle。它们是当前的包级约束。

- **SearXNG 实例由你自己运行** —— 该 bundle 之所以无密钥，是因为它自托管；若配置的基址上没有可达的实例，每次 `web_search` 都会以 `WEB_PROVIDER_ERROR` 失败。
- **实例必须启用 JSON 格式** —— 没有 `search.formats: [json]` 时，每次搜索都返回 HTML 页面并失败。
- **限流器（limiter）可能拒绝请求** —— 本地实例对类机器人流量可能应答 403/429；调整 `search.limiter` 或实例的机器人检测设置。
- **没有生成式答案** —— SearXNG 返回聚合结果，而不是合成响应，因此 `web_search` 输出只有来源。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
