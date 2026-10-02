/**
 * `SearxngSearchProvider`: a keyless `WebSearchProvider` backed by a local SearXNG
 * instance's JSON API (`GET /search?q=...&format=json`). It maps `content` to
 * `snippet` and `publishedDate` to `publishedAt`, drops entries without a URL,
 * and omits `content` because SearXNG returns no generated answer.
 * @module @deepseek-ai/dsh-web-search-searxng/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { SearxngError, SearxngResult, SearxngSearchResponse } from './types.ts'

/** Stable id this provider registers under. */
export const SEARXNG_PROVIDER_ID = 'searxng'

/** Default local SearXNG instance; `/search` is the operation. */
export const SEARXNG_DEFAULT_BASE_URL = 'http://localhost:8028'

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.2.0-rc.2'

/** Resolved provider options (the plugin's `apply` supplies env-var and constant defaults). */
export interface SearxngSearchProviderOptions {
  /** Instance base; `/search` is appended. */
  baseURL: string
  /** Comma-separated SearXNG categories sent as the `categories` parameter. */
  categories?: string
}

/**
 * Map one SearXNG result to a normalized source, or `undefined` when it carries
 * no URL (a source without a URL has nothing to cite). `content` becomes the
 * snippet when non-blank; a blank `content` yields a URL-only citation rather
 * than an invented snippet.
 *
 * @param result - one entry of SearXNG's `results[]`.
 * @returns the normalized source, or `undefined` when the entry has no URL.
 */
export function mapSearxngResult(result: SearxngResult): WebSearchSource | undefined {
  if (result.url === undefined || result.url.trim().length === 0) return undefined
  return {
    url: result.url,
    ...result.title !== undefined && result.title !== null && result.title.length > 0 ? { title: result.title } : {},
    ...result.content !== undefined && result.content !== null && result.content.trim().length > 0
      ? { snippet: result.content }
      : {},
    ...result.publishedDate !== undefined && result.publishedDate !== null && result.publishedDate.length > 0
      ? { publishedAt: result.publishedDate }
      : {},
  }
}

/**
 * Map a SearXNG response envelope to a normalized search result.
 *
 * @param response - the parsed `GET /search` response body.
 * @returns the normalized result; URL-less entries are dropped
 *   ({@link mapSearxngResult}). SearXNG returns no generated answer, so
 *   `content` is omitted and the seam owns `maxResults` truncation.
 */
export function mapSearxngResponse(response: SearxngSearchResponse): WebSearchResult {
  const sources = (response.results ?? [])
    .map(mapSearxngResult)
    .filter((source): source is WebSearchSource => source !== undefined)
  return { sources, truncated: false }
}

/** The keyless SearXNG-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class SearxngSearchProvider implements WebSearchProvider {
  readonly id = SEARXNG_PROVIDER_ID

  constructor(private readonly options: SearxngSearchProviderOptions) {}

  available(): boolean {
    return isValidBaseUrl(this.options.baseURL)
      && (this.options.categories === undefined || this.options.categories.trim().length > 0)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const url = new URL(`${this.options.baseURL}/search`)
    url.searchParams.set('format', 'json')
    url.searchParams.set('q', request.query)
    if (this.options.categories !== undefined) url.searchParams.set('categories', this.options.categories)
    let response: Response
    try {
      response = await fetch(url.toString(), {
        method: 'GET',
        redirect: 'error',
        headers: {
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`SearXNG search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `SearXNG API error (HTTP ${status})`
      try {
        const parsed = await response.json() as SearxngError
        const detail = parsed.message ?? parsed.error
        if (detail !== undefined && detail.length > 0) message = detail
      } catch (error: unknown) {
        // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed
        // into a generic HTTP-error message — cancellation is not a provider
        // error (the seam's cancellation contract).
        if (isAbortError(error)) throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
        // Otherwise: the HTTP status is already captured in `message` above; a
        // limiter HTML page or other non-JSON body can only cost a richer
        // provider message, never the real error.
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      const payload = await response.json() as SearxngSearchResponse
      return mapSearxngResponse(payload)
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`SearXNG returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
}

/** True when `baseURL` parses as an absolute URL (a cheap local config check). */
function isValidBaseUrl(baseURL: string): boolean {
  return URL.canParse(baseURL)
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
