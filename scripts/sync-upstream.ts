/**
 * Merge upstream/master into the fork and open a review PR.
 *
 * All merge, install, and generator work runs in a dedicated git worktree
 * (`.worktrees/sync-upstream`, gitignored) so the main checkout is never
 * modified, including its node_modules and working tree. Deterministic
 * conflicts (catalogs, schema, lockfile, generated docs, provider metadata)
 * are resolved by regeneration; conflicts in hand-edited files take the
 * upstream side and are listed in the PR body for the agent to re-apply
 * fork-local changes, after which the script exits 2.
 *
 * The worktree persists after each run so it can be inspected and reused by
 * later runs. Remove it with `git worktree remove --force .worktrees/sync-upstream`.
 *
 * Usage (from the repository root):
 *   pnpm exec tsx scripts/sync-upstream.ts            # full run, opens PR
 *   pnpm exec tsx scripts/sync-upstream.ts --dry-run  # report divergence only, no worktree
 */
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import process from 'node:process'

const DRY_RUN = process.argv.includes('--dry-run')
const SYNC_BRANCH = 'sync-upstream/master'
const UPSTREAM = 'upstream/master'
const FORK = 'origin/master'
const MARKER = '<!-- dsh-sync-upstream-changelog -->'
const MAX_ITEMS_PER_SECTION = 25
const WORKTREE_DIR = '.worktrees/sync-upstream'
const GENERATOR_JOBS: { label: string; args: readonly string[] }[] = [
  { label: 'config-catalog', args: ['pnpm', 'run', 'gen-config-catalog'] },
  { label: 'tool-catalog', args: ['pnpm', 'run', 'gen-tool-catalog'] },
  { label: 'persistence-catalog', args: ['pnpm', 'run', 'gen-persistence-catalog'] },
  { label: 'persistence-formats', args: ['pnpm', 'exec', 'tsx', 'scripts/persistence-formats.ts', '--write'] },
  { label: 'doc-graphs', args: ['pnpm', 'run', 'gen-doc-graphs'] },
  { label: 'cordis-catalog', args: ['pnpm', 'run', 'gen-cordis-catalog'] },
  { label: 'client-catalog', args: ['pnpm', 'run', 'gen-client-catalog'] },
  { label: 'plugin-packages', args: ['pnpm', 'run', 'gen-plugin-packages'] },
  { label: 'tsconfig-paths', args: ['pnpm', 'run', 'gen-tsconfig-paths'] },
  { label: 'provider-data', args: ['pnpm', 'run', 'gen-provider-data'] },
  { label: 'third-party-notices', args: ['pnpm', 'exec', 'tsx', 'scripts/gen-third-party-notices.ts'] },
]

/** Run a git command and return stdout. @param args - git arguments. @param cwd - working directory. @returns trimmed stdout. */
function git(args: readonly string[], cwd?: string): string {
  return execFileSync('git', args, { encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** Run a command, never throwing. @param args - program and arguments. @param cwd - working directory. @returns exit code and output. */
function sh(args: readonly string[], cwd?: string): { code: number; out: string } {
  const program = args[0]
  if (program === undefined) return { code: 1, out: 'sync-upstream: empty command' }
  try {
    const out = execFileSync(program, args.slice(1), { encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out }
  } catch (error: unknown) {
    const e = error as { code?: number; stdout?: string; stderr?: string }
    return { code: typeof e.code === 'number' ? e.code : 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

/** @param message - human-readable reason. */
function fail(message: string): never {
  console.error(`sync-upstream: ${message}`)
  process.exit(1)
}

/** @returns the upstream commits to bring in, oldest first, with their subjects. */
function upstreamCommits(base: string): { hash: string; subject: string }[] {
  return git(['log', '--reverse', '--format=%h %s', `${base}..${UPSTREAM}`])
    .split('\n')
    .filter(line => line.length > 0)
    .map((line) => {
      const space = line.indexOf(' ')
      return { hash: line.slice(0, space), subject: line.slice(space + 1) }
    })
}

/** @param subject - commit subject. @returns the changelog section it belongs to. */
function classify(subject: string): string {
  const lower = subject.toLowerCase()
  if (lower.startsWith('feat') || lower.startsWith('feature')) return 'Features'
  if (lower.startsWith('fix') || lower.startsWith('bug')) return 'Fixes'
  if (lower.startsWith('docs')) return 'Documentation'
  if (lower.startsWith('test')) return 'Tests'
  if (lower.startsWith('release') || lower.startsWith('revert')) return 'Releases / Vendors'
  return 'Refactor / Chores'
}

/** Build the changelog section of the PR body. @param commits - upstream commits. @param base - merge base. @returns markdown. */
function buildChangelog(commits: { hash: string; subject: string }[], base: string): string {
  const groups = new Map<string, string[]>()
  for (const { hash, subject } of commits) {
    const section = classify(subject)
    groups.set(section, [...(groups.get(section) ?? []), `- [${hash}](${hash}) ${subject}`])
  }
  const order = ['Features', 'Fixes', 'Documentation', 'Tests', 'Releases / Vendors', 'Refactor / Chores']
  const lines = [MARKER, `**Upstream:** \`${UPSTREAM}\` · **Fork base:** \`${FORK}\` · merge base \`${base.slice(0, 12)}\``, '']
  for (const section of order) {
    const items = groups.get(section)
    if (!items || items.length === 0) continue
    const shown = items.slice(0, MAX_ITEMS_PER_SECTION)
    lines.push(`### ${section} (${items.length})`, '', ...shown)
    if (items.length > shown.length) lines.push(`- …and ${items.length - shown.length} more (\`git log ${base}..${UPSTREAM}\`)`)
    lines.push('')
  }
  if (groups.size === 0) lines.push('No upstream commits to report.')
  return lines.join('\n').trimEnd()
}

/**
 * Resolve conflicted files in the worktree. Deterministic ones are regenerated
 * in a later step; semantic ones take the upstream side and are reported.
 * @param wt - worktree path.
 * @returns { auto, semantic } the resolved file sets.
 */
function resolveConflicts(wt: string): { auto: string[]; semantic: string[] } {
  const conflicted = git(['-C', wt, 'diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean)
  if (conflicted.length === 0) return { auto: [], semantic: [] }
  const semantic = conflicted.filter(file =>
    file.endsWith('/README.md') || file.endsWith('/README.zh.md') || file.endsWith('/README.i18n.yaml') || file === 'tsconfig.host.json',
  )
  const auto = conflicted.filter(file => !semantic.includes(file))
  for (const file of [...auto, ...semantic]) git(['-C', wt, 'checkout', '--theirs', '--', file])
  git(['-C', wt, 'add', '-A'])
  return { auto, semantic }
}

/**
 * Install dependencies in the worktree, reusing the main checkout's pnpm store
 * for hard links when it exists.
 * @param wt - worktree path. @param root - main checkout path.
 * @returns the failed job label, or null on success.
 */
function installWorktree(wt: string, root: string): string | null {
  const store = join(root, '.pnpm-store')
  const withStore = sh(['pnpm', 'install', '--store-dir', store], wt)
  if (withStore.code === 0) return null
  if (existsSync(store)) {
    const plain = sh(['pnpm', 'install'], wt)
    if (plain.code === 0) return null
    console.error(`sync-upstream: pnpm install failed (store and default):\n${plain.out.slice(0, 2000)}`)
    return 'lockfile'
  }
  console.error(`sync-upstream: pnpm install failed:\n${withStore.out.slice(0, 2000)}`)
  return 'lockfile'
}

/**
 * Regenerate every deterministic artifact from the merged source.
 * A failed job is recorded, not fatal: the PR body lists it for the agent.
 * @param wt - worktree path. @param root - main checkout path.
 * @returns { rewritten, failed } files rewritten and labels of failed jobs.
 */
function regenerateArtifacts(wt: string, root: string): { rewritten: string[]; failed: string[] } {
  const rewritten: string[] = []
  const failed: string[] = []
  const installFail = installWorktree(wt, root)
  if (installFail) failed.push(installFail)
  for (const file of git(['-C', wt, 'diff', '--name-only']).split('\n').filter(Boolean)) {
    if (!rewritten.includes(file)) rewritten.push(file)
  }
  git(['-C', wt, 'add', '-A'])
  for (const job of GENERATOR_JOBS) {
    const { code, out } = sh(job.args, wt)
    if (code !== 0) {
      failed.push(job.label)
      console.error(`sync-upstream: ${job.label} failed (reported in PR):\n${out.slice(0, 2000)}`)
      continue
    }
    for (const file of git(['-C', wt, 'diff', '--name-only']).split('\n').filter(Boolean)) {
      if (!rewritten.includes(file)) rewritten.push(file)
    }
    git(['-C', wt, 'add', '-A'])
  }
  return { rewritten, failed }
}

/** Re-record i18n section hashes so the pre-commit hook validates. @param wt - worktree path. @returns files rewritten. */
function reRecordTranslationPairing(wt: string): { rewritten: string[]; failed: boolean } {
  const { code, out } = sh(['pnpm', 'exec', 'tsx', 'scripts/verify-translation-pairing.ts', '--write', '--all'], wt)
  if (code !== 0) {
    console.error(`sync-upstream: translation pairing re-record failed:\n${out.slice(0, 2000)}`)
    return { rewritten: [], failed: true }
  }
  const rewritten = git(['-C', wt, 'diff', '--name-only', '*.i18n.yaml']).split('\n').filter(Boolean)
  git(['-C', wt, 'add', '-A'])
  return { rewritten, failed: false }
}

/**
 * Commit the worktree's staged state (merge or regeneration).
 * @param wt - worktree path.
 * @returns the commit hash (null when clean) and the hook rejection report (null on
 * success); a rejected commit is a semantic follow-up, not a crash.
 */
function commitWorktree(wt: string): { head: string | null; rejected: string | null } {
  const dirty = git(['-C', wt, 'status', '--porcelain'])
  const merging = sh(['git', '-C', wt, 'rev-parse', '--verify', 'MERGE_HEAD']).code === 0
  if (dirty.length === 0 && !merging) return { head: null, rejected: null }
  try {
    if (merging) git(['-C', wt, 'commit', '--no-edit'])
    else git(['-C', wt, 'commit', '-m', 'sync: regenerate artifacts from the merged upstream source'])
  } catch (error: unknown) {
    // A hook rejection leaves the staged merge in the worktree; the agent fixes the
    // rejection reason there and re-commits. That is a semantic follow-up, not a crash.
    const stderr = (error as { stderr?: string }).stderr ?? String(error)
    console.error(
      'sync-upstream: commit rejected by a hook (staged state left in the worktree for the agent to fix):\n'
        + stderr.slice(0, 2000),
    )
    return { head: null, rejected: stderr }
  }
  return { head: git(['-C', wt, 'rev-parse', 'HEAD']), rejected: null }
}

/**
 * GitHub REST helper for the PR API; some accounts lack the GraphQL permission `gh pr` uses.
 * @param method - HTTP method.
 * @param path - API path.
 * @param payload - JSON body, or null for GET.
 * @returns the parsed JSON response, or an { error } object on transport failure.
 */
function ghApi(method: string, path: string, payload: unknown): unknown {
  const token = sh(['gh', 'auth', 'token']).out.trim()
  const args = ['-s', '-X', method, '-H', `Authorization: Bearer ${token}`, '-H', 'Accept: application/vnd.github+json', `https://api.github.com${path}`]
  if (payload !== null) args.push('--data', JSON.stringify(payload))
  const { code, out } = sh(['curl', ...args])
  if (code !== 0) return { error: out }
  try {
    return JSON.parse(out)
  } catch {
    return { error: out }
  }
}

/**
 * Open the PR for the sync branch, updating it if one already exists.
 * @param title - PR title.
 * @param body - PR description.
 * @returns the PR URL.
 */
function openPr(title: string, body: string): string {
  const repo = git(['remote', 'get-url', 'origin']).replace(/^.*github\.com\//, '').replace(/\.git$/, '')
  const list = ghApi('GET', `/repos/${repo}/pulls?state=open&head=${SYNC_BRANCH}`, null) as { number?: number; html_url?: string }[]
  if (Array.isArray(list) && list.length > 0) {
    const pr = list[0]
    if (pr?.number !== undefined && pr.html_url !== undefined) {
      ghApi('PATCH', `/repos/${repo}/pulls/${pr.number}`, { title, body })
      return pr.html_url
    }
  }
  type PullResponse = { html_url?: string; message?: string }
  const created = ghApi('POST', `/repos/${repo}/pulls`, { base: 'master', head: SYNC_BRANCH, title, body }) as PullResponse
  if (created?.html_url === undefined) fail(`PR creation failed: ${created?.message ?? JSON.stringify(created)}`)
  return created.html_url
}

/**
 * Ensure the sync worktree exists on the sync branch, creating it from the
 * branch (reused) or from origin/master (fresh) as needed.
 * @param wt - worktree path.
 * @returns whether a new worktree was created ('fresh') or one was reused.
 */
function ensureWorktree(wt: string): 'fresh' | 'reused' {
  const worktrees = git(['worktree', 'list', '--porcelain']).split('\n')
  const checkout = worktrees.find(line => line === `worktree ${wt}`)
  if (checkout !== undefined) {
    const head = git(['-C', wt, 'rev-parse', '--abbrev-ref', 'HEAD'])
    if (head !== SYNC_BRANCH) fail(`worktree ${wt} is on ${head}, not ${SYNC_BRANCH}; remove it and rerun`)
    return 'reused'
  }
  if (worktrees.some(line => line === `branch refs/heads/${SYNC_BRANCH}`)) {
    fail(`${SYNC_BRANCH} is checked out in another worktree; check out ${FORK} there and rerun`)
  }
  const hasBranch = sh(['git', 'rev-parse', '--verify', `refs/heads/${SYNC_BRANCH}`]).code === 0
  if (hasBranch) git(['worktree', 'add', wt, SYNC_BRANCH])
  else git(['worktree', 'add', wt, '-b', SYNC_BRANCH, FORK])
  return 'fresh'
}

/**
 * Ensure upstream/master is merged into the worktree. A fresh worktree merges
 * now; a reused one skips a completed merge, resumes an in-progress one, or
 * merges newer upstream commits on top.
 * @param wt - worktree path. @param mode - fresh or reused worktree.
 * @returns { auto, semantic } resolved conflict sets (empty when no conflicts).
 */
function ensureMerged(wt: string, mode: 'fresh' | 'reused'): { auto: string[]; semantic: string[] } {
  if (mode === 'reused') {
    const merged = sh(['git', '-C', wt, 'merge-base', '--is-ancestor', UPSTREAM, 'HEAD'])
    if (merged.code === 0) return { auto: [], semantic: [] }
    const inProgress = sh(['git', '-C', wt, 'rev-parse', '--verify', 'MERGE_HEAD']).code === 0
    if (inProgress) return resolveConflicts(wt)
  }
  const merge = sh(['git', '-C', wt, 'merge', '--no-edit', UPSTREAM])
  if (merge.code !== 0 && merge.code !== 1) fail(`merge failed:\n${merge.out.slice(0, 2000)}`)
  return resolveConflicts(wt)
}

function main(): void {
  const root = process.cwd()
  const merging = sh(['git', '-C', root, 'rev-parse', '--verify', 'MERGE_HEAD']).code === 0
  const unmerged = git(['-C', root, 'ls-files', '-u'])
  if (merging || unmerged.length > 0) {
    fail(`main checkout at ${root} has a merge in progress or unmerged index entries; `
      + 'finish or abort it there (git status) and rerun. The script only works in its own worktree and '
      + 'must not run over a conflicted tree.')
  }
  git(['fetch', 'upstream', '--prune'])
  git(['fetch', 'origin', '--prune'])
  const base = git(['merge-base', FORK, UPSTREAM])
  const commits = upstreamCommits(base)
  if (commits.length === 0) {
    console.log('sync-upstream: fork is already up to date with upstream; nothing to do.')
    return
  }
  console.log(`sync-upstream: bringing in ${commits.length} upstream commit(s) from ${base.slice(0, 12)}..${UPSTREAM}`)

  if (DRY_RUN) {
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
    const preview = sh(['git', 'merge-tree', '--write-tree', branch, UPSTREAM])
    const conflictFiles = preview.out.split('\n')
      .filter(line => line.startsWith('CONFLICT'))
      .map(line => line.slice(line.lastIndexOf(' in ') + 4))
      .filter(Boolean)
    console.log(`sync-upstream: ${commits.length} commits, ${conflictFiles.length} file(s) would conflict.`)
    console.log('sync-upstream: dry run only; no worktree, commit, or PR created.')
    console.log(conflictFiles.map(file => `  ${file}`).join('\n'))
    return
  }

  const wt = join(root, WORKTREE_DIR)
  const mode = ensureWorktree(wt)
  console.log(`sync-upstream: worktree ${wt} (${mode === 'fresh' ? 'created' : 'reused'})`)
  const { auto, semantic } = ensureMerged(wt, mode)
  const { rewritten, failed } = regenerateArtifacts(wt, root)
  const { rewritten: i18nRewritten, failed: i18nFailed } = reRecordTranslationPairing(wt)
  const resolved = [...new Set([...auto, ...semantic, ...rewritten, ...i18nRewritten])].sort()
  if (i18nFailed) failed.push('translation-pairing')

  const changelog = buildChangelog(commits, base)
  const sections: string[] = []
  if (resolved.length > 0) {
    const note = 'Auto files were regenerated from source; semantic files took the upstream side and need fork-local re-application.'
    sections.push(['## Conflict resolution', '', ...resolved.map(file => `- \`${file}\``), '', note].join('\n'))
  }
  if (failed.length > 0) {
    sections.push(['## Regeneration failures', '', ...failed.map(label => `- \`${label}\``)].join('\n'))
  }
  const footer = '_This PR was opened by the `sync-upstream` automation task. Review resolved conflicts before merging._'
  const header = `# Sync upstream \`${base.slice(0, 12)}\` → \`${UPSTREAM}\``
  const middle = sections.length > 0 ? `\n\n${sections.join('\n\n')}` : ''
  const body = `${header}\n\n${changelog}${middle}\n\n${footer}`

  const { head, rejected } = commitWorktree(wt)
  if (rejected !== null) {
    const recommit = `git -C ${WORKTREE_DIR} push --force-with-lease origin ${SYNC_BRANCH}`
    const followUp = 'sync-upstream: agent follow-up needed: the commit was rejected by a hook; fix the rejection '
      + `reason in the worktree at ${WORKTREE_DIR}, re-commit, then run: ${recommit}`
    console.log(followUp)
    process.exit(2)
  }
  if (head !== null) console.log(`sync-upstream: committed at ${head.slice(0, 12)}`)
  else console.log('sync-upstream: nothing new to commit; pushing existing branch state')
  const push = sh(['git', '-C', wt, 'push', '--force-with-lease', 'origin', SYNC_BRANCH])
  if (push.code !== 0) fail(`push of ${SYNC_BRANCH} failed (remote moved?):\n${push.out.slice(0, 2000)}`)
  const url = openPr(`sync: upstream ${base.slice(0, 10)} → ${UPSTREAM}`, body)
  if (!url) fail('failed to open the PR; check `gh auth status` and rerun')
  console.log(`sync-upstream: PR at ${url}`)
  console.log(`sync-upstream: worktree kept at ${wt}; remove with: git worktree remove --force ${WORKTREE_DIR}`)
  if (semantic.length > 0 || failed.length > 0) {
    const followUp = 'sync-upstream: agent follow-up needed: re-apply fork changes on the semantic files, fix '
      + `regeneration failures on ${SYNC_BRANCH}, then \`git -C ${WORKTREE_DIR} push --force-with-lease origin ${SYNC_BRANCH}\`.`
    console.log(followUp)
    process.exitCode = 2
  }
}

void main()
