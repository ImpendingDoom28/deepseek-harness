/**
 * Keyless SearXNG-backed `WebSearchProvider` plugin. It contributes to the
 * `ctx.web` registry without owning the service and needs no API key: it talks
 * to a locally run SearXNG instance through its JSON search API.
 *
 * @module @deepseek-ai/dsh-web-search-searxng
 */

import type { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { SEARXNG_DEFAULT_BASE_URL, SearxngSearchProvider } from './provider.ts'

export {
  SEARXNG_DEFAULT_BASE_URL,
  SEARXNG_PROVIDER_ID,
  SearxngSearchProvider,
  mapSearxngResponse,
  mapSearxngResult,
} from './provider.ts'
export type { SearxngSearchProviderOptions } from './provider.ts'
export type { SearxngError, SearxngResult, SearxngSearchResponse } from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-searxng'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** Instance base; `/search` is appended. Falls back to `$SEARXNG_BASE_URL`, then `http://localhost:8028`. */
  baseURL?: string
  /** Comma-separated SearXNG categories (for example `general,news`). Omitted = instance default. */
  categories?: string
}

export const Config: z<Config> = z.object({
  // Declared without a default on purpose: `$SEARXNG_BASE_URL` and the constant
  // default apply in that order at registration, and a rendered default here
  // would make a configured instance read as the fallback.
  baseURL: z.string(),
  categories: z.string(),
})

/** Register the keyless SearXNG search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new SearxngSearchProvider({
    // Every environment layer may name the instance: the product trusts the
    // project it is launched in, and no managed credential is involved.
    baseURL: config.baseURL
      ?? launchEnvironmentOf(ctx).get('SEARXNG_BASE_URL')?.value
      ?? SEARXNG_DEFAULT_BASE_URL,
    ...config.categories !== undefined && config.categories !== '' ? { categories: config.categories } : {},
  }))
}
