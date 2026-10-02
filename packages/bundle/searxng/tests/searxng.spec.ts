/**
 * The bundle's substance is its patch file: the `dsh.bundle.patch` manifest
 * field must name a real, parseable patch list that re-points web search at
 * keyless SearXNG. The composition test selects the bundle over a staged
 * headless profile through the real Loader path.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { composeEntries, loadProfile } from '@deepseek-ai/dsh-app-boot'

const installAnchor = fileURLToPath(new URL('../../../../apps/cli/package.json', import.meta.url))
const resourcePackage = '@deepseek-ai/dsh-web-search-searxng'

describe('dsh-searxng bundle', () => {
  it('declares a parseable patch list that re-points web search at SearXNG', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const parsed = yaml.load(readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'), {
      schema: entryListSchema,
    })
    expect(Array.isArray(parsed)).toBe(true)
    const webRow = (parsed as { id?: string; config?: Record<string, unknown> }[]).find(row => row.id === 'web')
    expect(webRow?.config).toEqual({ searchProvider: 'searxng', fetchProvider: 'http' })
    const inserts = (parsed as { insert?: { id?: string; name?: string }[] }[]).flatMap(patch => patch.insert ?? [])
    expect(inserts).toContainEqual({ id: 'web-search-searxng', name: resourcePackage })
    // verify-cordis-config: the inserted plugin must be a declared dependency.
    expect(manifest.dependencies).toHaveProperty(resourcePackage)
  })

  it('composes the bundle over base and headless', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-searxng-profile-'))
    try {
      // The bundle is optional: no template initializes a profile with it, so
      // stage the headless profile and select the bundle the way the plugin
      // manager does.
      const profileDir = join(home, 'profiles', 'headless')
      mkdirSync(profileDir, { recursive: true })
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
        name: 'dsh-profile-headless',
        private: true,
        dependencies: { '@deepseek-ai/dsh-searxng': 'workspace:*' },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', '@deepseek-ai/dsh-searxng'] } },
      }, undefined, 2) + '\n')
      const profile = loadProfile('dsh', 'headless', installAnchor, home)
      const warnings: string[] = []
      const rows = composeEntries([...profile.layers.map(layer => layer.patches), profile.patches], message => warnings.push(message))
      expect(warnings).toEqual([])
      expect(rows.find(row => row.id === 'web')?.config).toEqual({ searchProvider: 'searxng', fetchProvider: 'http' })
      expect(rows.filter(row => row.name === resourcePackage)).toEqual([{ id: 'web-search-searxng', name: resourcePackage }])
      // The headless runner still rides over base; the layer only changes search.
      expect(rows.some(row => row.id === 'headless-runner')).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
