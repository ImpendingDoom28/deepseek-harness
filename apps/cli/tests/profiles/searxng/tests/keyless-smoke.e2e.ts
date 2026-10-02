import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const PROCESS_TIMEOUT_MS = 60_000
const TEST_TIMEOUT_MS = PROCESS_TIMEOUT_MS + 15_000
const binScript = fileURLToPath(new URL('../../../../../../packages/test-support/loader-smoke/tests/fixtures/headless-driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/cli.patch.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../../../../tsconfig.json', import.meta.url))

describe('searxng optional bundle keyless smoke', () => {
  it('boots headless with the SearXNG bundle enabled, routes web_search through the local SearXNG instance, and persists the turn', async () => {
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'searxng-agent',
      tempDirPrefix: 'searxng-agent-smoke-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath, 'find the fixture release notes'],
      tsconfigPath,
      processTimeoutMs: PROCESS_TIMEOUT_MS,
      // The SearXNG bundle ships optional, so the profile already carries it:
      // the same `dsh.profile.bundles` list the plugin manager writes when the
      // bundle is enabled. The provider defaults to its localhost:8028 host and
      // the fixture's fetch rewrite redirects that host to the bound loopback port.
      async prepare(cwd) {
        const profileDir = `${cwd}/.dsh/profiles/headless`
        await mkdir(profileDir, { recursive: true })
        await writeFile(
          `${profileDir}/package.json`,
          JSON.stringify({
            name: 'dsh-profile-headless',
            private: true,
            dependencies: { '@deepseek-ai/dsh-searxng': 'workspace:*' },
            dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', '@deepseek-ai/dsh-searxng'] } },
          }, undefined, 2) + '\n',
        )
      },
    })
    const lines = stdout.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    const events = lines.slice(0, -1).map(line => line['event'] as SessionEvent)
    const result = lines.at(-1)
    expect(stderr).toBe('')
    // The model asked for a web search in the first step...
    expect(events.some(event => event.type === 'tool/call' && event.data.name === 'web_search')).toBe(true)
    // ...and the fixture's deterministic source came back through the seam.
    const toolResult = events.find(event => event.type === 'tool/result')
    expect(JSON.stringify(toolResult)).toContain('SEARXNG_SEARCH_ROUND_TRIP')
    expect(JSON.stringify(toolResult)).toContain('https://fixture.example/result-1')
    // The final answer carries the round-trip marker end to end.
    expect(String(result?.['output'])).toContain('SEARXNG_SEARCH_ROUND_TRIP')
    expect(result).toMatchObject({ type: 'result' })
  }, TEST_TIMEOUT_MS)
})
