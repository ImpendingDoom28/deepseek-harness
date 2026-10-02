/** Deterministic keyless SearXNG loopback endpoint for the searxng profile smoke. */
import { createServer, type Server } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'

/** Cordis plugin name. */
export const name = 'searxng-fixture-server'

/** The provider's default base; the fetch rewrite redirects only this host. */
const DEFAULT_BASE_URL = 'http://localhost:8028'

/** The one deterministic source the fixture returns for any query. */
const FIXTURE_RESULT = {
  url: 'https://fixture.example/result-1',
  title: 'Fixture result',
  content: 'SEARXNG_SEARCH_ROUND_TRIP',
  score: 100,
  engines: ['fixture'],
  publishedDate: '2026-01-01',
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('error', onError)
      reject(error)
    }
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError)
      resolve()
    })
  })
}

function rewriteToFixture(url: string, endpoint: string): string {
  const parsed = new URL(url)
  if (parsed.host === new URL(DEFAULT_BASE_URL).host) {
    const target = new URL(endpoint)
    parsed.host = target.host
    return parsed.toString()
  }
  return url
}

/**
 * Start the loopback SearXNG endpoint as a Cordis effect and redirect the
 * provider's default base host to the bound port for the effect's lifetime.
 */
export async function apply(ctx: Context): Promise<void> {
  await ctx.effect(async () => {
    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? '/', DEFAULT_BASE_URL)
      if (request.method === 'GET' && requestUrl.pathname === '/search'
        && requestUrl.searchParams.get('format') === 'json') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ results: [FIXTURE_RESULT] }))
        return
      }
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('not found')
    })
    let restoreFetch = (): void => {}
    try {
      await listen(server)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        throw new Error(`${name}: loopback listener has no TCP address`)
      }
      const boundPort = address.port
      const originalFetch = globalThis.fetch
      // `RequestInfo | URL` is the fetch input union, so the override is
      // assignable to `globalThis.fetch` without a cast.
      const fixtureFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        return originalFetch(rewriteToFixture(url, `http://127.0.0.1:${boundPort}`), init)
      }
      globalThis.fetch = fixtureFetch
      restoreFetch = (): void => {
        if (globalThis.fetch !== fixtureFetch) {
          throw new Error(`${name}: global fetch owner changed before cleanup`)
        }
        globalThis.fetch = originalFetch
      }
      // The smoke must never hold the process open past protocol shutdown.
      server.unref()
      return () => {
        restoreFetch()
        server.close()
        server.closeAllConnections()
      }
    } catch (cause: unknown) {
      try {
        restoreFetch()
        server.close()
        server.closeAllConnections()
      } catch {
        // The server is already dead; the original setup error is the one to surface.
      }
      throw cause
    }
  }, name)
}
