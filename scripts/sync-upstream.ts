/**
 * Merge upstream/master into the fork and open a review PR.
 *
 * Deterministic steps the script owns: fetch, create/reuse the sync branch,
 * merge, resolve conflicts that regenerate from source (catalogs, schema,
 * lockfile, generated docs), re-record i18n section hashes, build the changelog,
 * commit the merge, push, and open (or update) the PR. Conflicts in hand-edited
 * files take the upstream side and are listed in the PR body for the agent to
 * re-apply fork-local changes; the script then exits 2 so the agent finishes
 * the job on the same branch.
 *
 * Usage (from the repository root):
 *   pnpm exec tsx scripts/sync-upstream.ts            # full run, opens PR
 *   pnpm exec tsx scripts/sync-upstream.ts --dry-run  # report divergence only, no merge
 */
import { execFileSync } from 'node:child_process'
import process from 'node:process'

const DRY_RUN = process.argv.includes('--dry-run')
const SYNC_BRANCH = 'sync-upstream/master'
const UPSTREAM = 'upstream/master'
const FORK = 'origin/master'
const MARKER = '<!-- dsh-sync-upstream-changelog -->'
const MAX_ITEMS_PER_SECTION = 25
const REGRESSION_JOBS: { label: string; args: readonly string[] }[] = [
  { label: 'lockfile', args: ['pnpm', 'install'] },
  { label: 'config-catalog', args: ['pnpm', 'run', 'gen-config-catalog'] },
  { label: 'tool-catalog', args: ['pnpm', 'run', 'gen-tool-catalog'] },
  { label: 'persistence-catalog', args: ['pnpm', 'run', 'gen-persistence-catalog'] },
  { label: 'persistence-formats', args: ['pnpm', 'exec', 'tsx', 'scripts/persistence-formats.ts', '--write'] },
  { label: 'doc-graphs', args: ['pnpm', 'run', 'gen-doc-graphs'] },
  { label: 'cordis-catalog', args: ['pnpm', 'run', 'gen-cordis-catalog'] },
  { label: 'client-catalog', args: ['pnpm', 'run', 'gen-client-catalog'] },
  { label: 'plugin-packages', args: ['pnpm', 'run', 'gen-plugin-packages'] },
  { label: 'tsconfig-paths', args: ['pnpm', 'run', 'gen-tsconfig-paths'] },
  { label: 'third-party-notices', args: ['pnpm', 'exec', 'tsx', 'scripts/gen-third-party-notices.ts'] },
]

/** Run a git command and return stdout. @param args - git arguments. @returns trimmed stdout. */
function git(args: readonly string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** Run a command, never throwing. @param args - program and arguments. @returns exit code and combined output. */
function sh(args: readonly string[]): { code: number; out: string } {
  const program = args[0]
  if (program === undefined) return { code: 1, out: 'sync-upstream: empty command' }
  try {
    return { code: 0, out: execFileSync(program, args.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
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
 * Resolve conflicted files. Deterministic ones are regenerated in a later step;
 * semantic ones take the upstream side and are reported to the agent.
 * @returns { auto, semantic } the resolved file sets.
 */
function resolveConflicts(): { auto: string[]; semantic: string[] } {
  const conflicted = git(['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean)
  if (conflicted.length === 0) return { auto: [], semantic: [] }
  const semantic = conflicted.filter(file =>
    file.endsWith('/README.md') || file.endsWith('/README.zh.md') || file.endsWith('/README.i18n.yaml') || file === 'tsconfig.host.json',
  )
  const auto = conflicted.filter(file => !semantic.includes(file))
  for (const file of [...auto, ...semantic]) git(['checkout', '--theirs', '--', file])
  git(['add', '-A'])
  return { auto, semantic }
}

/**
 * Regenerate every deterministic artifact from the merged source.
 * A failed job is recorded, not fatal: the PR body lists it for the agent.
 * @returns { rewritten, failed } files rewritten and labels of failed jobs.
 */
function regenerateArtifacts(): { rewritten: string[]; failed: string[] } {
  const rewritten: string[] = []
  const failed: string[] = []
  for (const job of REGRESSION_JOBS) {
    const { code, out } = sh(job.args)
    if (code !== 0) {
      failed.push(job.label)
      console.error(`sync-upstream: ${job.label} failed (reported in PR):\n${out.slice(0, 2000)}`)
      continue
    }
    for (const file of git(['diff', '--name-only']).split('\n').filter(Boolean)) {
      if (!rewritten.includes(file)) rewritten.push(file)
    }
    git(['add', '-A'])
  }
  return { rewritten, failed }
}

/** Re-record i18n section hashes so the pre-merge-commit hook validates. @returns files rewritten. */
function reRecordTranslationPairing(): { rewritten: string[]; failed: boolean } {
  const { code, out } = sh(['pnpm', 'exec', 'tsx', 'scripts/verify-translation-pairing.ts', '--write', '--all'])
  if (code !== 0) {
    console.error(`sync-upstream: translation pairing re-record failed:\n${out.slice(0, 2000)}`)
    return { rewritten: [], failed: true }
  }
  const rewritten = git(['diff', '--name-only', '*.i18n.yaml']).split('\n').filter(Boolean)
  git(['add', '-A'])
  return { rewritten, failed: false }
}

/** Commit the in-progress merge. @returns the merge commit hash. */
function commitMerge(): string {
  try {
    git(['commit', '--no-edit'])
  } catch (error: unknown) {
    fail(`merge commit failed (hook rejection?): ${(error as { stderr?: string }).stderr ?? error}`)
  }
  return git(['rev-parse', 'HEAD'])
}

/**
 * Open the PR for the sync branch, updating it if one already exists.
 * @param title - PR title.
 * @param body - PR description.
 * @returns the PR URL.
 */
function openPr(title: string, body: string): string {
  const existing = sh(['gh', 'pr', 'list', '--head', SYNC_BRANCH, '--state', 'open', '--json', 'number,url', '--jq', '.[0] // empty'])
  if (existing.code === 0 && existing.out.trim().length > 0) {
    const parts = existing.out.trim().split(',')
    const number = parts[0] ?? ''
    const url = parts.slice(1).join(',')
    if (number !== '' && url !== '') {
      sh(['gh', 'pr', 'edit', number, '--title', title, '--body', body])
      return url
    }
  }
  const created = sh(['gh', 'pr', 'create', '--base', 'master', '--head', SYNC_BRANCH, '--title', title, '--body', body])
  return created.out.trim().split('\n').pop() ?? ''
}

function main(): void {
  const status = git(['status', '--porcelain'])
  if (status.length > 0) fail('working tree is not clean; commit or stash changes first')
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch === SYNC_BRANCH) fail(`already on ${SYNC_BRANCH}; finish the open PR there, then \`git checkout master\``)
  const inProgress = sh(['git', 'rev-parse', '--verify', 'MERGE_HEAD']).out
  if (inProgress.trim().length === 40 && branch !== SYNC_BRANCH) fail(`an in-progress merge exists on ${branch}; finish or abort it first`)

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
    const preview = sh(['git', 'merge-tree', '--write-tree', branch, UPSTREAM])
    const conflictFiles = preview.out.split('\n')
      .filter(line => line.startsWith('CONFLICT'))
      .map(line => line.slice(line.lastIndexOf(' in ') + 4))
      .filter(Boolean)
    console.log(`sync-upstream: ${commits.length} commits, ${conflictFiles.length} file(s) would conflict.`)
    console.log('sync-upstream: dry run only; no branch, commit, or PR created.')
    console.log(conflictFiles.map(file => `  ${file}`).join('\n'))
    return
  }

  git(['checkout', '-B', SYNC_BRANCH, FORK])
  sh(['git', 'merge', '--no-edit', UPSTREAM]) // nonzero exit on conflict is expected.
  const { auto, semantic } = resolveConflicts()
  const { rewritten, failed } = regenerateArtifacts()
  const { rewritten: i18nRewritten, failed: i18nFailed } = reRecordTranslationPairing()
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

  const head = commitMerge()
  console.log(`sync-upstream: merge committed at ${head.slice(0, 12)}`)
  const push = sh(['git', 'push', '--force-with-lease', 'origin', SYNC_BRANCH])
  if (push.code !== 0) fail(`push of ${SYNC_BRANCH} failed (remote moved?):\n${push.out}`)
  const url = openPr(`sync: upstream ${base.slice(0, 10)} → ${UPSTREAM}`, body)
  if (!url) fail('failed to open the PR; check `gh auth status` and rerun')
  console.log(`sync-upstream: PR at ${url}`)
  if (semantic.length > 0 || failed.length > 0) {
    const followUp = 'sync-upstream: agent follow-up needed: re-apply fork changes on the semantic files, fix '
      + `regeneration failures, commit on ${SYNC_BRANCH}, then \`git push --force-with-lease origin ${SYNC_BRANCH}\`.`
    console.log(followUp)
    process.exitCode = 2
  }
}

void main()
