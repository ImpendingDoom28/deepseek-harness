/**
 * Wire types for the SearXNG search API (`GET {base}/search?q=...&format=json`).
 * Types only — no runtime code. SearXNG is a keyless metasearch engine; with
 * the `format: [json]` option enabled on the instance, it answers with a
 * `results[]` array where each entry carries a URL, an optional title, an
 * optional `content` snippet, an optional `score`, the `engines` that
 * produced it, and an optional `publishedDate`.
 *
 * @module @deepseek-ai/dsh-web-search-searxng/types
 */

/** One entry of SearXNG's `results[]`. */
export interface SearxngResult {
  /** Citation URL; optional on the wire — entries without it are dropped. */
  url?: string
  title?: string | null
  /** Snippet of the search result's page content. */
  content?: string | null
  /** Relevance score assigned by the engines; not portable into the seam. */
  score?: number | null
  /** Engine names that produced this result. */
  engines?: string[]
  /** Publication/crawl date as a provider-supplied string, when known. */
  publishedDate?: string | null
}

/** SearXNG's search response envelope. */
export interface SearxngSearchResponse {
  results?: SearxngResult[]
}

/** SearXNG's error response envelope (best-effort; fields vary by failure). */
export interface SearxngError {
  message?: string
  error?: string
}
