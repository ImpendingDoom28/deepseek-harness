import { describe, expect, it } from 'vitest'
import { SearxngSearchProvider, SEARXNG_DEFAULT_BASE_URL } from '@deepseek-ai/dsh-web-search-searxng'

/**
 * Real-instance smoke for the keyless SearXNG search provider. Self-skips unless a reachable
 * instance is exported as `$SEARXNG_BASE_URL` (defaults to the `http://localhost:8028` constant
 * when the variable is unset), per the with-external-service e2e policy in docs/testing.md.
 */
const baseURL = process.env.SEARXNG_BASE_URL ?? SEARXNG_DEFAULT_BASE_URL
const maybe = process.env.SEARXNG_BASE_URL !== undefined && process.env.SEARXNG_BASE_URL.length > 0
  ? describe
  : describe.skip

maybe('SearxngSearchProvider real instance', () => {
  it('returns sources for a live query', async () => {
    const provider = new SearxngSearchProvider({ baseURL })
    const result = await provider.search({ query: 'DeepSeek Harness', maxResults: 5 })
    expect(result.sources).not.toHaveLength(0)
    for (const source of result.sources) expect(source.url).toMatch(/^https?:\/\//)
  }, 30_000)
})
