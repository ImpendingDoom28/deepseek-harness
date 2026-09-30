import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { createUserMessage, type GenerateOptions, type Message } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import UserQuestionService, { type AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import DebugModeController, { FINISH_DEBUG } from '@deepseek-ai/dsh-debug'
import { MockAdapter, toolCallResponse, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

// Mirrors the preset workflow prompt: it references the per-session loopback
// endpoint through the `{{debug_log_url}}` prompt variable, so this suite also
// proves the placeholder interpolates to a real URL when debug mode is active
// (an unresolved reference would throw at assembly and break the session).
const DEBUG_PROMPT = 'Investigate the issue, add instrumentation that POSTs log entries to the debug-log endpoint at {{debug_log_url}}, and call finish_debug with the collection steps.'

const PROCEED_TEXT = 'Issue is reproduced, please continue. The captured log entries are in this result:\n'
  + '{"at":"2026-09-17T10:00:00.000Z","step":"save","data":{"crash":"stack"}}'
const FIXED_TEXT = 'Issue is fixed, please remove the instrumentation. Debug mode has ended.'

/**
 * Full-loop REAL composition: the debug plugin is booted through the Loader
 * from a test-only `cordis.yml` (not a hand-built `ctx.plugin`), beside the
 * real loop, session, tools, and user-questions services. Only the model is
 * mocked; the loop, the session log, and the plugin are real. Debug mode is a
 * logged state, so the assertions cover the `debug/mode` event, the
 * `debug:policy` system-prompt section the loop carries, and the
 * loopback debug-log endpoint the captured entries travel through end to end.
 */
async function harness(
  adapter: MockAdapter,
  answer: AskUserQuestionAnswer,
  workspace: string,
): Promise<Context> {
  const configPath = join(workspace, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-agent-loop'",
    '  config:',
    '    agents: []',
    "- name: '@deepseek-ai/dsh-user-questions'",
    "- name: '@deepseek-ai/dsh-debug'",
    '  config:',
    `    prompt: ${JSON.stringify(DEBUG_PROMPT)}`,
    '',
  ].join('\n'))

  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(workspace).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-user-questions', UserQuestionService],
    ['@deepseek-ai/dsh-debug', DebugModeController],
  ])
  const internal: ModuleLoaderV2 = {
    version: 'v2',
    import: async (specifier: string) => {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
    loadCache: new Map(),
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
  ctx.loader.internal = internal
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  const unloaded = [...ctx.loader.entries()]
    .filter(entry => entry.fiber === undefined && !entry.disabled)
    .map(entry => entry.options.name)
  expect(unloaded).toEqual([])

  ctx.llm.registerAdapter(['mock'], adapter)
  // The debug review blocks on a human answer; this is the UI stand-in.
  ctx.on('user-questions/request', () => Promise.resolve(answer))
  return ctx
}

/** The loopback debug-log endpoint URL for one agent's session. */
async function debugLogUrl(ctx: Context, agent: Agent): Promise<string> {
  const assembly = await ctx.systemPrompt.assemble({ agent })
  return assembly.variables.debug_log_url ?? ''
}

/** POST one captured entry to the endpoint, as the user's run would. */
async function postEntry(ctx: Context, agent: Agent, entry: { step: string; at: string; data?: unknown }): Promise<Response> {
  const url = await debugLogUrl(ctx, agent)
  return fetch(url, { method: 'POST', body: JSON.stringify(entry) })
}

function findEvent<T extends SessionEvent['type']>(
  log: readonly SessionEvent[],
  type: T,
  position: 'first' | 'last' = 'first',
): Extract<SessionEvent, { type: T }> {
  const found = position === 'first'
    ? log.find(event => event.type === type)
    : log.findLast(event => event.type === type)
  if (!found) throw new Error(`no ${type} event in the session log`)
  return found as Extract<SessionEvent, { type: T }>
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

/** Read the debug unit that backs the service in this full composition. */
function debugActive(ctx: Context, agent: Agent): boolean {
  const state = ctx.sessionProjections.stateOf(agent.session, 'debug')
  if (state === undefined) throw new Error('debug projection is not registered')
  return state.active
}

/** Join the text blocks of one message. */
function textOf(message: Message): string {
  return message.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** Text of the leading system message of one loop-built request. */
function requestSystem(options: GenerateOptions | undefined): string {
  const head = options?.messages[0]
  if (head?.role !== 'system') throw new Error('the request does not lead with a system message')
  return textOf(head)
}

describe('debug mode through the agent loop', () => {
  it('a pre-turn set() makes the FIRST header debug-shaped, and Proceed keeps the session in debug mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-debug-it-proceed-'))
    const ws = join(root, 'workspace')
    await mkdir(ws, { recursive: true })
    const adapter = new MockAdapter([
      toolCallResponse('call-1', FINISH_DEBUG, { instructions: 'Run the app and save a profile.' }, 'presenting the steps'),
      textResponse('Reading the logs now.'),
    ])
    const ctx = await harness(adapter, { answers: [{ id: 'debug-review', selected: ['Proceed'] }] }, ws)
    try {
      const agent = await ctx.agentLoop.create(SessionId('it-debug-proceed'), { provider: 'mock', model: 'mock' }, { cwd: ws })
      // Selected while idle: the mode commits immediately, before the first assembly.
      ctx.debug.set(agent, true)
      // The user runs the reproduction and POSTs the captured state to the
      // loopback endpoint; the entry is appended as a debug/log event.
      const post = await postEntry(ctx, agent, { step: 'save', at: '2026-09-17T10:00:00.000Z', data: { crash: 'stack' } })
      expect(post.status).toBe(202)

      const idle = waitForIdle(ctx, agent)
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'the app crashes on save' }], source: { kind: 'user' } }))
      await idle

      const log = agent.session.snapshotEvents()
      // The mode is logged before the first header (the section is the state
      // statement), and the workflow prompt rides the system node, not the
      // user message.
      const debugMode = findEvent(log, 'debug/mode')
      const header = findEvent(log, 'request/header')
      expect(debugMode.data.active).toBe(true)
      expect(debugMode.seq).toBeLessThan(header.seq)
      const system = requestSystem(adapter.requests[0])
      // The `{{debug_log_url}}` placeholder resolved to the loopback endpoint
      // URL for this session (it is not the literal placeholder, and it names
      // the session the instrumentation POSTs to).
      const url = await debugLogUrl(ctx, agent)
      expect(system).toContain(`debug-log endpoint at ${url}`)
      expect(system).not.toContain('{{debug_log_url}}')
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/debug\/it-debug-proceed$/)
      // The captured entry is logged through the endpoint.
      const entries = log.filter(event => event.type === 'debug/log')
      expect(entries).toHaveLength(1)
      expect(findEvent(log, 'debug/log').data.step).toBe('save')
      // The issue is the only user message: the workflow is not injected.
      const userTexts = log
        .filter((event): event is Extract<SessionEvent, { type: 'user/message' }> =>
          event.type === 'user/message' && event.data.source.kind === 'user')
        .map(event => textOf(event.data))
      expect(userTexts).toEqual(['the app crashes on save'])

      const result = findEvent(log, 'tool/result')
      expect(result.data.message.isError).toBe(false)
      expect(result.data.message.content[0]).toEqual({ type: 'text', text: PROCEED_TEXT })
      expect(log.some(event => event.type === 'turn/end')).toBe(true)
      // Proceed never leaves the session: still active after the review.
      expect(debugActive(ctx, agent)).toBe(true)
      expect(log.filter(event => event.type === 'debug/mode')).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a finish_debug Mark-as-fixed returns the fixed note, ends the session, and resets the cycle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-debug-it-fixed-'))
    const ws = join(root, 'workspace')
    await mkdir(ws, { recursive: true })
    const adapter = new MockAdapter([
      toolCallResponse('call-1', FINISH_DEBUG, { instructions: 'Run the app and save a profile.' }, 'presenting the steps'),
      textResponse('Removing the instrumentation.'),
    ])
    const ctx = await harness(adapter, { answers: [{ id: 'debug-review', selected: ['Mark as fixed'] }] }, ws)
    try {
      const agent = await ctx.agentLoop.create(SessionId('it-debug-fixed'), { provider: 'mock', model: 'mock' }, { cwd: ws })
      ctx.debug.set(agent, true)
      // A captured entry exists in the cycle; Mark-as-fixed discards it (no
      // file to clear — the endpoint replaces file capture).
      const post = await postEntry(ctx, agent, { step: 'save', at: '2026-09-17T10:00:00.000Z', data: { crash: 'stack' } })
      expect(post.status).toBe(202)

      const idle = waitForIdle(ctx, agent)
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'the app crashes on save' }], source: { kind: 'user' } }))
      await idle

      const log = agent.session.snapshotEvents()
      const result = findEvent(log, 'tool/result')
      expect(result.data.message.isError).toBe(false)
      expect(result.data.message.content[0]).toEqual({ type: 'text', text: FIXED_TEXT })
      // Mark-as-fixed ends the session: the exit lands at the next accepted
      // step boundary (the finish tool's result already narrated the exit), so
      // a log-only debug/mode off follows the entry.
      const modes = log.filter(event => event.type === 'debug/mode')
      expect(modes.map(event => event.data.active)).toEqual([true, false])
      expect(debugActive(ctx, agent)).toBe(false)
      // The exit selection is not narrated: the only plugin notice is the
      // entry (the first header already told the model the mode, so the entry
      // itself stays silent too).
      expect(log.filter(event => event.type === 'user/message' && event.data.source.kind === 'debug-mode')).toHaveLength(0)
      // The successful finish resets the cycle: the captured entry is not
      // carried into the next one.
      const state = ctx.sessionProjections.stateOf(agent.session, 'debug')
      expect(state?.logs).toEqual([])
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('the debug:policy section is absent from requests in the default mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-debug-it-default-'))
    const ws = join(root, 'workspace')
    await mkdir(ws, { recursive: true })
    const adapter = new MockAdapter([
      textResponse('Default mode, no debug.'),
    ])
    const ctx = await harness(adapter, { answers: [] }, ws)
    try {
      const agent = await ctx.agentLoop.create(SessionId('it-debug-default'), { provider: 'mock', model: 'mock' }, { cwd: ws })
      const idle = waitForIdle(ctx, agent)
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
      await idle

      expect(requestSystem(adapter.requests[0])).not.toContain(DEBUG_PROMPT)
      expect(debugActive(ctx, agent)).toBe(false)
      expect(agent.session.snapshotEvents().some(event => event.type === 'debug/mode')).toBe(false)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
