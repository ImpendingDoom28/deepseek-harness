import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import {
  SearxngSearchProvider,
  SEARXNG_PROVIDER_ID,
} from '@deepseek-ai/dsh-web-search-searxng'
import * as searxngPlugin from '@deepseek-ai/dsh-web-search-searxng'
import { mapSearxngResponse, mapSearxngResult } from '../src/provider'

const options = { baseURL: 'http://searxng.test:8028' }

type FetchMock = ReturnType<typeof vi.fn<(input: string, init?: RequestInit) => Promise<Response>>>

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

function fetchMock(body: () => Response | Promise<Response>): FetchMock {
  return vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(() => Promise.resolve(body()))
}

function callArgs(mock: FetchMock, index = 0): [string, RequestInit | undefined] {
  return mock.mock.calls[index] as [string, RequestInit | undefined]
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Searxng result mapping', () => {
  it('maps a full result entry', () => {
    expect(
      mapSearxngResult({
        url: 'https://a.test',
        title: 'A',
        content: 'a snippet',
        score: 10,
        engines: ['ddg'],
        publishedDate: '2026-01-01',
      }),
    ).toEqual({
      url: 'https://a.test',
      title: 'A',
      snippet: 'a snippet',
      publishedAt: '2026-01-01',
    })
  })

  it('drops a result without a usable URL', () => {
    expect(mapSearxngResult({ url: '   ' })).toBeUndefined()
    expect(mapSearxngResult({ url: '' })).toBeUndefined()
  })

  it('omits null/empty optional fields rather than emitting them', () => {
    expect(
      mapSearxngResult({
        url: 'https://a.test',
        title: null,
        content: null,
        publishedDate: null,
      }),
    ).toEqual({ url: 'https://a.test' })
    expect(
      mapSearxngResult({ url: 'https://a.test', title: '', publishedDate: '' }),
    ).toEqual({ url: 'https://a.test' })
  })

  it('keeps a URL-only source when the content snippet is blank', () => {
    expect(mapSearxngResult({ url: 'https://a.test', content: '   ' })).toEqual({ url: 'https://a.test' })
    expect(mapSearxngResult({ url: 'https://a.test', content: '' })).toEqual({ url: 'https://a.test' })
  })

  it('discards score and engines, which the seam has no field for', () => {
    expect(
      mapSearxngResult({
        url: 'https://a.test',
        content: 's',
        score: 100,
        engines: ['google', 'bing'],
      }),
    ).toEqual({ url: 'https://a.test', snippet: 's' })
  })

  it('maps a response to a result with no content and filtered sources', () => {
    const result = mapSearxngResponse({
      results: [
        { url: 'https://a.test', content: 'one' },
        { content: 'no url' },
        { url: 'https://b.test', title: 'B', content: 'two' },
      ],
    })
    expect(result).toEqual({
      sources: [
        { url: 'https://a.test', snippet: 'one' },
        { url: 'https://b.test', title: 'B', snippet: 'two' },
      ],
      truncated: false,
    })
    expect(result.content).toBeUndefined()
  })

  it('tolerates a missing results array', () => {
    expect(mapSearxngResponse({}).sources).toEqual([])
  })
})

describe('SearxngSearchProvider availability', () => {
  it('is misconfigured when the base URL is unparseable', () => {
    expect(
      new SearxngSearchProvider({ ...options, baseURL: 'not a url' }).available(),
    ).toBe(false)
  })

  it('is available with a parseable base URL', () => {
    expect(new SearxngSearchProvider(options).available()).toBe(true)
    expect(new SearxngSearchProvider({ baseURL: 'http://localhost:8028' }).available()).toBe(true)
  })

  it('is misconfigured when categories are set but blank', () => {
    expect(new SearxngSearchProvider({ ...options, categories: '   ' }).available()).toBe(false)
  })

  it('is available when categories carry a value', () => {
    expect(new SearxngSearchProvider({ ...options, categories: 'general,news' }).available()).toBe(true)
  })
})

describe('SearxngSearchProvider request mapping', () => {
  it('sends q and format=json on a GET with the attribution headers', async () => {
    const mock = fetchMock(() => jsonResponse({ results: [{ url: 'https://a.test', content: 'hi' }] }))
    vi.stubGlobal('fetch', mock)
    await new SearxngSearchProvider(options).search({ query: 'hello' })
    expect(mock).toHaveBeenCalledOnce()
    const [url, init] = callArgs(mock)
    expect(url).toBe('http://searxng.test:8028/search?format=json&q=hello')
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' })
    expect(init?.body).toBeUndefined()
    expect((init?.headers as Record<string, string>)['accept']).toBe('application/json')
    expect((init?.headers as Record<string, string>)['user-agent']).toBe('deepseek-harness/0.2.0-rc.2')
  })

  it('adds the categories parameter only when configured', async () => {
    const mock = fetchMock(() => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', mock)
    await new SearxngSearchProvider({ ...options, categories: 'general,news' }).search({ query: 'q' })
    const [url] = callArgs(mock)
    expect(url).toBe('http://searxng.test:8028/search?format=json&q=q&categories=general%2Cnews')
    await new SearxngSearchProvider(options).search({ query: 'q' })
    const [plainUrl] = callArgs(mock, 1)
    expect(plainUrl).not.toContain('categories')
  })

  it('omits the request maxResults: SearXNG has no result-count query parameter', async () => {
    const mock = fetchMock(() => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', mock)
    await new SearxngSearchProvider(options).search({ query: 'q', maxResults: 2 })
    const [url] = callArgs(mock)
    expect(url).toBe('http://searxng.test:8028/search?format=json&q=q')
  })

  it('forwards the abort signal', async () => {
    const mock = fetchMock(() => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', mock)
    const controller = new AbortController()
    await new SearxngSearchProvider(options).search({ query: 'q' }, controller.signal)
    const [, init] = callArgs(mock)
    expect(init?.signal).toBe(controller.signal)
  })
})

describe('SearxngSearchProvider error handling', () => {
  it('maps an HTTP error to WEB_PROVIDER_ERROR with the provider message', async () => {
    vi.stubGlobal('fetch', fetchMock(() => jsonResponse({ message: 'rate limited' }, { status: 429 })))
    await expect(new SearxngSearchProvider(options).search({ query: 'q' })).rejects.toThrow(
      expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'rate limited' }),
    )
  })

  it('keeps a status-line message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', fetchMock(() => new Response('bot detected', { status: 403 })))
    await expect(new SearxngSearchProvider(options).search({ query: 'q' })).rejects.toThrow(
      expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'SearXNG API error (HTTP 403)' }),
    )
  })

  it('keeps the status-line message when the JSON error body carries no detail', async () => {
    vi.stubGlobal('fetch', fetchMock(() => jsonResponse({}, { status: 500 })))
    await expect(new SearxngSearchProvider(options).search({ query: 'q' })).rejects.toThrow(
      expect.objectContaining({ message: 'SearXNG API error (HTTP 500)' }),
    )
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(new SearxngSearchProvider(options).search({ query: 'q' })).rejects.toThrow(
      expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }),
    )
  })

  it('maps an abort to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(new SearxngSearchProvider(options).search({ query: 'q' })).rejects.toThrow(
      expect.objectContaining({ code: 'WEB_ABORTED' }),
    )
  })

  it('maps an unparseable success body to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', fetchMock(() => new Response('<html>not json</html>', { status: 200 })))
    await expect(new SearxngSearchProvider(options).search({ query: 'q' })).rejects.toThrow(
      expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }),
    )
  })

  it('surfaces an abort during success-body parse as WEB_ABORTED, not provider error', async () => {
    const body = {
      json: () => Promise.reject(new DOMException('aborted', 'AbortError')),
      ok: true,
      status: 200,
    } as Response
    vi.stubGlobal('fetch', fetchMock(() => body))
    await expect(new SearxngSearchProvider(options).search({ query: 'q' })).rejects.toThrow(
      expect.objectContaining({ code: 'WEB_ABORTED' }),
    )
  })

  it('surfaces an abort during error-body parse as WEB_ABORTED', async () => {
    const body = {
      json: () => Promise.reject(new DOMException('aborted', 'AbortError')),
      ok: false,
      status: 500,
    } as Response
    vi.stubGlobal('fetch', fetchMock(() => body))
    await expect(new SearxngSearchProvider(options).search({ query: 'q' })).rejects.toThrow(
      expect.objectContaining({ code: 'WEB_ABORTED' }),
    )
  })
})

describe('web-search-searxng plugin registration', () => {
  it('registers the provider into ctx.web (HMR-safe)', async () => {
    vi.stubGlobal('fetch', fetchMock(() => jsonResponse({ results: [] })))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: SEARXNG_PROVIDER_ID })
    const fiber = await ctx.plugin(searxngPlugin, {})
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({
      sources: [],
      truncated: false,
    })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' })).rejects.toThrow(
      expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }),
    )
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in searxngPlugin).toBe(false)
  })

  it('threads categories config into the request', async () => {
    const mock = fetchMock(() => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', mock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: SEARXNG_PROVIDER_ID })
    await ctx.plugin(searxngPlugin, { baseURL: 'http://searxng.test:8028', categories: 'news' })
    await ctx.web.search({ query: 'q' })
    const [url] = callArgs(mock)
    expect(url).toContain('categories=news')
  })
})
