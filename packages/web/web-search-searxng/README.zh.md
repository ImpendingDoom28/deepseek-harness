---
description: "ctx.web 的免密钥 SearXNG 搜索提供方：部署方如何把本地 SearXNG 实例挂载为无需 API 密钥的搜索后端。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-searxng

[English](README.md) | 中文

## 概述

有了 `dsh-web-search-searxng`，harness 可以通过本地运行的 SearXNG 实例搜索 web——无需 API 密钥、无需外部服务账号。它一次调用返回可引用来源，但不带生成答案：元搜索引擎聚合你配置的多个上游引擎，harness 把它们的原始结果透传为 `sources[]`。SearXNG 在请求侧没有结果数量控制，因此返回的来源会在事后被截断到请求的上限。某个引擎省略结果元数据时，来源回退为只含 URL 的引用。面向模型的 `web_search` 工具位于 `dsh-tool-web`。

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

在已加载 web 服务的组合中挂载本提供方；它以 `searxng` 搜索提供方身份注册，因此当它是唯一可用的搜索后端时，`ctx.web.search()` 会自动解析到它——也可以用 `searchProvider: searxng` 固定。可选的 [`dsh-searxng`](../../bundle/searxng/README.zh.md) bundle 正是为某个选中的 profile 这样做：它把 base `web` 行改指向 `searchProvider: searxng` 并插入本提供方。

### 何时选择

当部署运行（或能够运行）自己的 SearXNG 实例、并希望获得免密钥的自托管 web 搜索时选择此后端。端点基址无法解析或配置的分类列表为空白时，提供方不可用——每次搜索调用都会以结构化错误失败。

### 最小配置

加载 web 服务与本提供方；实例基址回退到启动环境中的 `$SEARXNG_BASE_URL`，再到 `http://localhost:8028`。SearXNG 必须在实例侧启用 JSON 格式：

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

| 字段 | 默认值 | 含义 |
|---|---|---|
| `baseURL` | `$SEARXNG_BASE_URL`，再到 `http://localhost:8028` | 实例基址；追加 `/search`。无法解析时提供方不可用 |
| `categories` | （未设置） | 以逗号分隔的 SearXNG 分类（例如 `general,news`），作为 `categories` 参数发送。未设置时使用实例默认值 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-searxng)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 搜索返回什么

`sources[]` 由 SearXNG 的 `results[]` 构建：`url`、存在时的 `title`、非空时作为 `snippet` 的 `content`，以及作为 `publishedAt` 的 `publishedDate`。没有 URL 的结果被丢弃，空白的 `content` 产生只含 URL 的引用而不是编造的摘要。SearXNG 不返回生成答案，因此 `content` 始终缺失，服务通过截断并标记来强制执行 `maxResults`。

### 失败与恢复

提供方失败——HTTP 错误（包括限速器的 403/429）、网络失败、响应体无法解析或结构不符——以 `WebError` `WEB_PROVIDER_ERROR` 呈现；中止请求以 `WEB_ABORTED` 呈现。HTTP 重定向会在访问 `Location` 指向的目标之前被拒绝，并以 `WEB_PROVIDER_ERROR` 呈现。404 或 HTML 响应体通常意味着实例未启用 JSON 格式。调用方根据错误码进行路由；面向模型的 `web_search` 工具会在自己的错误包装层内把失败呈现给模型。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释提供方背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该提供方是 SearXNG JSON 搜索端点之上的薄适配器，遵循两条刻意的规则：

- **不生成答案。** SearXNG 聚合上游引擎并返回它们的原始结果，因此本提供方省略 `content`，只把 `sources[]` 带入 seam。
- **引擎元数据透传，不编造。** 每个协议字段在存在时映射到对应的 seam 字段；缺失或空白的字段被省略而不是填充，这正是服务上 `title`／`snippet`／`publishedAt` 保持可选的原因。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、环境变量回退、提供方注册 |
| [`src/provider.ts`](src/provider.ts) | `SearxngSearchProvider`：请求分发、中止分类、结果映射 |
| [`src/types.ts`](src/types.ts) | 搜索响应的 SearXNG 协议类型 |
| — | 不发布运行时不变量配套入口；除所属 seam 强制执行的约定外，本包不公开独立的事件序列或可变数据关系。 |

### 请求与映射流程

`search()` 以 `redirect: 'error'` 发送 `GET {baseURL}/search`，携带 `format=json`、查询与可选分类。响应的 `results[]` 经过上面的字段映射变为 `sources[]`，服务在返回路径上应用最终的 `maxResults` 上限。中止——名为 `AbortError` 的 `DOMException`——变为 `WEB_ABORTED`；其余情况变为 `WEB_PROVIDER_ERROR`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享词汇逐步进入服务、面向模型的工具与设计依据。

- [Web 子系统](../../../docs/subsystems/web.zh.md)——穷尽的搜索请求/结果词汇与错误码。
- [Web 包地图](../README.zh.md)——包家族与各角色。
- [dsh-web](../web/README.zh.md)——本提供方注册进入的 web 服务。
- [dsh-tool-web](../tool-web/README.zh.md)——渲染本提供方来源的面向模型 `web_search` 工具。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-searxng)——每个受支持配置字段及其来源声明。
- [Web 能力 seam 决策](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)——搜索与 fetch 为何共享一个提供方选择服务。

-----

<a id="model-experience"></a>
## 模型体验

### 辅助 SearXNG 请求

#### 模型看到什么

一个独立的 SearXNG 请求把 `<query>` 原样带到实例的搜索端点。该请求不属于对话模型的上下文。

#### Token 影响

提供方本身不消耗模型 token；实例的上游引擎自行处理。

#### KV 缓存影响

与对话请求缓存无关；不涉及模型缓存。

### 经由工具的对话结果，间接

#### 模型看到什么

通过 `dsh-tool-web`，对话模型看到带标题、摘要与 URL 的来源。本提供方的精确失败文案是 `SearXNG search aborted`、`SearXNG search request failed: <error>` 与 `SearXNG returned an unprocessable response body: <error>`；HTTP 失败保留提供方的消息。错误包装层归消费方所有。

#### Token 影响

注册不产生直接的对话 token。来源 token 取决于数据，来源数量受实例限制，保留的结果或错误会在压缩前被反复重发。

#### KV 缓存影响

仅追加；新可见内容跟随可复用的请求前缀，不会使已有 KV 缓存条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了本提供方不合适的使用场景。它们是当前的包约束。

- **实例必须启用 JSON 格式**——SearXNG 配置中没有 `search.formats: [json]` 时，每次搜索都会返回 HTML 页面并以 `WEB_PROVIDER_ERROR` 失败。
- **限速器可能拒绝请求**——本地实例可能以 403/429 拒绝类机器人的流量；错误携带实例的消息，调整 `search.limiter` 或实例的 `botdetection` 配置即可恢复。
- **过量返回的来源仍消耗 token 与延迟**——请求侧没有结果数量控制，`maxResults` 只能靠服务事后截断执行，实例返回其配置的完整页大小。
- **引擎元数据逐条变化**——`title`、`snippet` 与 `publishedAt` 因引擎而异，部分引擎的来源会渲染为只含 URL 的引用。
- **中止分类基于错误形态**——只有名为 `AbortError` 的 `DOMException` 映射到 `WEB_ABORTED`；携带自定义原因的中止（例如 `dsh-timeout` 的 `TimeoutReason`）会以 `WEB_PROVIDER_ERROR` 呈现。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与未定方向。它明确不具权威性——已发布行为、限制与依据位于上述章节及链接的 Agent Note 中。

#### 未来：更宽的 SearXNG 控制面

SearXNG 的其他搜索控制（语言、时间范围、安全搜索级别、`engines` 选择）保持未公开。公开它们需要先有提供方中立的字段，因此该家族增加一个协调的控制，而不是厂商专属的参数。

</details>
