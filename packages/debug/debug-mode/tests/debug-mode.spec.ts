import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt, { type PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import SessionStore, { Session, SessionId, SessionSeq, type SessionEvent, type UserMessage } from '@deepseek-ai/dsh-session'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import UserQuestionService, {
  UserQuestionError, type AskUserQuestionAnswer, type AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import CommandRuntime, { CommandId } from '@deepseek-ai/dsh-commands'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import DebugModeController, { FINISH_DEBUG, debugProjectionDefinition, resolveConfig } from '../src/index.ts'
import type { DebugModeConfig } from '../src/index.ts'
import type { DebugUnitState } from '../src/types.ts'

const TEST_PROMPT = 'Debug the reported issue, then call finish_debug.'
const DEBUG_CONFIG = { prompt: TEST_PROMPT } satisfies DebugModeConfig

const signal = (): AbortSignal => new AbortController().signal

interface QuestionAnswerer {
  ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>
}

function registerQuestionAnswerer(ctx: Context, answerer: QuestionAnswerer): () => void {
  return ctx.on('user-questions/request', request => answerer.ask(request))
}

/**
 * Drives the REAL plugin: mounts `dsh-debug` beside real `SystemPrompt` and
 * `ToolRuntime` services, with fake Agents carrying real `Session`s and a
 * real scoped `agent.ctx` minted through `createScope`.
 * Request boundaries are simulated by dispatching the real pre-step waterfall
 * and the following `step/start` session event used by the loop.
 */

async function agentWithSession(
  ctx: Context,
  id = 'agent-1',
  { active }: { active?: boolean } = {},
): Promise<Agent & { session: Session }> {
  // A live store session when a store is mounted (the command executor logs
  // lifecycle events through it); bare otherwise (fold/tool-only benches).
  const session = Session.create(SessionId(id))
  const agent = {
    id: SessionId(id),
    session,
    options: {},
    inject(message: UserMessage) {
      session.append('user/message', message, { surfaceOp: 'append' })
    },
  } as Agent & { session: Session }
  let scoped!: Context
  await ctx.plugin(Object.assign((inner: Context) => { scoped = createScope(inner, agent).ctx }, {
    inject: ['tools'],
  }))
  ;(agent as { ctx?: Context }).ctx = scoped
  // Seeded debug state lands before the creation announcement, matching resume.
  if (active !== undefined) session.append('debug/mode', { active })
  const agents = ctx.get('agents')
  if (agents === undefined) {
    ctx.emit('agent/created', { agent, source: 'startup' })
  } else {
    agents.enter(agent, undefined)
    agents.announce(agent, 'startup')
  }
  return agent
}

function assembleFor(ctx: Context, agent: Agent): Promise<PromptAssembly> {
  // Bare test agents carry no `ctx`, so the assembly runs without a scope:
  // the debug variable reads `agent.session`, which is all it needs.
  return ctx.systemPrompt.assemble({ agent })
}

function foldDebugMode(events: readonly SessionEvent[], end = events.length): boolean {
  let state: DebugUnitState = debugProjectionDefinition.init()
  let index = 0
  for (const event of events) {
    if (index >= end) break
    index++
    state = debugProjectionDefinition.apply(state, event)
  }
  return state.active
}

async function mountProjectionSeam(ctx: Context): Promise<void> {
  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
}

async function setup(config: DebugModeConfig = DEBUG_CONFIG): Promise<Context> {
  const ctx = new Context()
  await mountProjectionSeam(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(DebugModeController, config)
  return ctx
}

/**
 * Dispatch pre-step processing and optionally its following step-start commit.
 */
async function boundary(ctx: Context, agent: Agent & { session: Session }, type: 'pre-step' | 'step-start'): Promise<void> {
  const events = agentEvents(ctx, agent)
  const message = createUserMessage({
    content: [{ type: 'text', text: 'boundary probe' }],
    source: { kind: 'user' },
  })
  const sig = new AbortController().signal
  const decision = await events.waterfall(
    'agent/pre-step',
    { messages: [message], turn: 1, step: 1, signal: sig },
    () => Promise.resolve({ kind: 'enter' as const, messages: [message] }),
  )
  if (decision.kind === 'enter') {
    for (const message of decision.messages.slice(1)) {
      agent.session.append('user/message', message, { surfaceOp: 'append' })
    }
  }
  if (type === 'step-start') {
    const event = agent.session.append('step/start', { turn: 1, step: 1 })
    ctx.emit('session/event', agent.session, event)
  }
}

/** Open a turn so a selection queues for the boundary flush (the mid-turn shape). */
function openTurn(session: Session, turn = 0): void {
  session.append('turn/start', { turn })
}

/** Close the open turn (the between-turns shape: selections commit immediately). */
function closeTurn(session: Session, turn = 0): void {
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** Append a minimal `request/header` snapshot so the log has a "what the model was told" anchor. */
function header(session: Session): void {
  session.append('request/header', { header: { config: { provider: 'test', model: 'test-model' } }, reason: 'initial' })
}

function noticeTexts(session: Session): string[] {
  return session.snapshotEvents()
    .filter(event => event.type === 'user/message' && event.data.source.kind === 'debug-mode')
    .map(event => (event.data as { content: { type: string; text?: string }[] }).content.map(block => block.text ?? '').join(''))
}

function registerNamedTools(ctx: Context, names: string[]): void {
  for (const name of names) {
    ctx.tools.register(defineContentToolFixture({
      name,
      description: `test tool ${name}`,
      parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: `ran ${name}` }]),
    }))
  }
}

let callCounter = 0
function execute(ctx: Context, name: string, agent?: Agent) {
  return ctx.tools.execute({
    callId: ToolCallId(`call-${++callCounter}`),
    name,
    arguments: {},
    signal: signal(),
    ...agent ? { agent } : {},
  })
}

/** A live store session (the command executor and the tool root off its cwd). */
async function rootAgent(ctx: Context, cwd?: string): Promise<Agent> {
  const session = cwd === undefined
    ? ctx.sessions.create(SessionId('agent-dbg'))
    : ctx.sessions.create(SessionId('agent-dbg'), { meta: { cwd } })
  const agent = { id: session.id, session, options: {} } as Agent
  ctx.agents.enter(agent, undefined)
  return agent
}

async function setupWithQuestions(answerer: QuestionAnswerer) {
  const ctx = new Context()
  await mountProjectionSeam(ctx)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(UserQuestionService)
  registerQuestionAnswerer(ctx, answerer)
  await ctx.plugin(DebugModeController, DEBUG_CONFIG)
  return ctx
}

/** The loopback endpoint URL for one agent's session (the variable is resolved at assembly). */
async function debugLogUrl(ctx: Context, agent: Agent): Promise<string> {
  const assembly = await ctx.systemPrompt.assemble({ agent })
  return assembly.variables.debug_log_url ?? ''
}

describe('resolveConfig', () => {
  it('accepts a non-empty prompt and returns a detached copy', () => {
    expect(resolveConfig(DEBUG_CONFIG)).toEqual({ prompt: TEST_PROMPT })
    expect(resolveConfig(DEBUG_CONFIG)).not.toBe(DEBUG_CONFIG)
  })

  it.each([
    ['a missing prompt', {} as never],
    ['a blank prompt', { prompt: '   ' } as never],
    ['a non-string prompt', { prompt: 12 } as never],
    ['an unknown key', { prompt: TEST_PROMPT, extra: 'x' } as never],
  ])('rejects %s at load', (_case, config) => {
    expect(() => resolveConfig(config)).toThrow(/DebugModeConfig/)
  })
})

describe('the service', () => {
  it('registers debug state directly but requires turnBoundary state', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const agent = await agentWithSession(ctx, 'missing-debug-projection-keys')
    const debugMode = new DebugModeController(ctx, DEBUG_CONFIG)
    await new Promise(resolve => setImmediate(resolve))
    expect(debugMode.get(agent)).toEqual({ active: false })
    expect(() => debugMode.set(agent, true)).toThrow('debug-mode requires the turnBoundary session projection')
  })

  it('reads the folded state', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    expect(ctx.debug.get(agent)).toEqual({ active: false })
    agent.session.append('debug/mode', { active: true })
    expect(ctx.debug.get(agent)).toEqual({ active: true })
  })

  it('selects inactive as the debug exit target during an open turn', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    agent.session.append('debug/mode', { active: true })
    openTurn(agent.session)
    expect(ctx.debug.set(agent, false)).toBe('queued')
    expect(ctx.debug.get(agent)).toEqual({ active: true, pending: false })
  })

  it('drops a no-op set (target equals pending, else the current fold)', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    openTurn(agent.session)
    expect(ctx.debug.set(agent, false)).toBe('noop')
    expect(ctx.debug.get(agent)).toEqual({ active: false })
    expect(ctx.debug.set(agent, true)).toBe('queued')
    expect(ctx.debug.set(agent, true)).toBe('noop')
    expect(ctx.debug.get(agent)).toEqual({ active: false, pending: true })
  })

  it('a between-turns selection commits debug/mode immediately (no boundary would come)', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx, 'agent-idle')
    expect(ctx.debug.set(agent, true)).toBe('committed')
    expect(foldDebugMode(agent.session.snapshotEvents())).toBe(true)
    expect(ctx.debug.get(agent)).toEqual({ active: true })
    // Immediately reversible, still without a boundary.
    expect(ctx.debug.set(agent, false)).toBe('committed')
    expect(foldDebugMode(agent.session.snapshotEvents())).toBe(false)
    // A later boundary finds nothing pending — no double append.
    await boundary(ctx, agent, 'step-start')
    expect(agent.session.snapshotEvents().filter(event => event.type === 'debug/mode')).toHaveLength(2)
  })

  it('a between-turns reversal of a mid-turn pending intent cancels without logging', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    openTurn(agent.session)
    expect(ctx.debug.set(agent, true)).toBe('queued')
    closeTurn(agent.session)
    // Back to the logged state: the pending intent clears, nothing lands.
    expect(ctx.debug.set(agent, false)).toBe('cancelled')
    expect(agent.session.snapshotEvents().some(event => event.type === 'debug/mode')).toBe(false)
    expect(ctx.debug.get(agent)).toEqual({ active: false })
  })

  it('a between-turns commit narrates when the last header told the model otherwise', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx, 'agent-idle-narrate')
    header(agent.session)
    ctx.debug.set(agent, true)
    expect(noticeTexts(agent.session)).toEqual(['The user switched this session to debug mode.'])
  })
})

describe('the boundary flush', () => {
  it('is inert when no selection is pending', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    await boundary(ctx, agent, 'pre-step')
    expect(agent.session.snapshotEvents().some(event => event.type === 'debug/mode')).toBe(false)
  })

  it('flushes from pre-step before the following step/start', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    openTurn(agent.session)
    ctx.debug.set(agent, true)
    await boundary(ctx, agent, 'pre-step')
    expect(foldDebugMode(agent.session.snapshotEvents())).toBe(true)
    expect(ctx.debug.get(agent)).toEqual({ active: true })
  })

  it('removes the pre-step flush when the plugin fiber is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await mountProjectionSeam(ctx)
    const fiber = await ctx.plugin(DebugModeController, DEBUG_CONFIG)
    const agent = await agentWithSession(ctx)
    openTurn(agent.session)
    ctx.debug.set(agent, true)
    await fiber.dispose()
    await boundary(ctx, agent, 'pre-step')
    expect(agent.session.snapshotEvents().some(event => event.type === 'debug/mode')).toBe(false)
  })

  it('flushes at the between-step seam too', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    ctx.debug.set(agent, true)
    await boundary(ctx, agent, 'step-start')
    expect(foldDebugMode(agent.session.snapshotEvents())).toBe(true)
  })

  it('nets out a flip sequence that returns to the folded mode (no append, no notice)', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    openTurn(agent.session)
    ctx.debug.set(agent, true)
    ctx.debug.set(agent, false)
    await boundary(ctx, agent, 'pre-step')
    expect(agent.session.snapshotEvents().some(event => event.type === 'debug/mode')).toBe(false)
    expect(noticeTexts(agent.session)).toEqual([])
  })

  it('narrates nothing before the first request header (the section is the state statement)', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    ctx.debug.set(agent, true)
    await boundary(ctx, agent, 'pre-step')
    expect(noticeTexts(agent.session)).toEqual([])
  })

  it('narrates once when the flushed mode differs from what the last header told the model', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    header(agent.session)
    ctx.debug.set(agent, true)
    await boundary(ctx, agent, 'step-start')
    expect(noticeTexts(agent.session)).toEqual(['The user switched this session to debug mode.'])
    await boundary(ctx, agent, 'step-start')
    expect(noticeTexts(agent.session)).toEqual(['The user switched this session to debug mode.'])
  })

  it('narrates through the pre-step waterfall when the last header told the model otherwise', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    header(agent.session)
    openTurn(agent.session)
    ctx.debug.set(agent, true)
    await boundary(ctx, agent, 'pre-step')
    expect(foldDebugMode(agent.session.snapshotEvents())).toBe(true)
    expect(noticeTexts(agent.session)).toEqual(['The user switched this session to debug mode.'])
  })

  it('narrates a switch back to the default mode with the default wording', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    agent.session.append('debug/mode', { active: true })
    header(agent.session)
    ctx.debug.set(agent, false)
    await boundary(ctx, agent, 'step-start')
    expect(noticeTexts(agent.session)).toEqual(['The user switched this session back to the default mode.'])
  })

  it('stays silent when the header already reflects the flushed mode', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    agent.session.append('debug/mode', { active: true })
    header(agent.session)
    agent.session.append('debug/mode', { active: false })
    ctx.debug.set(agent, true)
    await boundary(ctx, agent, 'step-start')
    expect(foldDebugMode(agent.session.snapshotEvents())).toBe(true)
    expect(noticeTexts(agent.session)).toEqual([])
  })

  it('contains an append failure instead of blocking the prompt or the turn', async () => {
    const ctx = await setup()
    const warn = vi.fn()
    ctx.logger.warn = warn as never
    const agent = await agentWithSession(ctx)
    openTurn(agent.session)
    ctx.debug.set(agent, true)
    const original = agent.session.append.bind(agent.session)
    // Only the flush's own debug/mode append fails; the boundary event itself
    // lands (the loop appended it before the between-step hook fires).
    agent.session.append = ((type: Parameters<Session['append']>[0], data: never) => {
      if (type === 'debug/mode') throw new Error('backend gone')
      return original(type, data)
    }) as Session['append']
    await boundary(ctx, agent, 'step-start')
    expect(warn).toHaveBeenCalledOnce()
    // The failed flush re-parks the intent (cleared only after a landed
    // append), so the next healthy boundary converges the log with the
    // picker's optimistic state instead of dropping the switch forever.
    expect(ctx.debug.get(agent)).toEqual({ active: false, pending: true })
    agent.session.append = original
    await boundary(ctx, agent, 'step-start')
    expect(foldDebugMode(agent.session.snapshotEvents())).toBe(true)
    expect(ctx.debug.get(agent).pending).toBeUndefined()
  })

  it('contains a pre-step append failure and keeps the intent pending', async () => {
    const ctx = await setup()
    const warn = vi.fn()
    ctx.logger.warn = warn as never
    const agent = await agentWithSession(ctx)
    openTurn(agent.session)
    ctx.debug.set(agent, true)
    const original = agent.session.append.bind(agent.session)
    agent.session.append = ((type: Parameters<Session['append']>[0], data: never) => {
      if (type === 'debug/mode') throw new Error('backend gone')
      return original(type, data)
    }) as Session['append']
    await boundary(ctx, agent, 'pre-step')
    expect(warn).toHaveBeenCalledOnce()
    expect(ctx.debug.get(agent)).toEqual({ active: false, pending: true })
  })
})

describe('the log window fold', () => {
  it('accumulates entries in order and resets on a successful finish_debug result', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx, 'log-window-agent')
    agent.session.append('debug/mode', { active: true })
    agent.session.append('debug/log', { step: 'save', at: '2026-09-17T10:00:00.000Z' })
    agent.session.append('debug/log', { step: 'save', at: '2026-09-17T10:00:01.000Z', data: { code: 500 } })

    const projection = ctx.sessionProjections
    const state = projection.stateOf(agent.session, 'debug')
    expect(state).toEqual(expect.objectContaining({
      active: true,
      logs: [
        { step: 'save', at: '2026-09-17T10:00:00.000Z' },
        { step: 'save', at: '2026-09-17T10:00:01.000Z', data: { code: 500 } },
      ],
    }))

    const callId = ToolCallId('window-call')
    const callEvent = agent.session.append('tool/call', { turn: 1, step: 1, callId, name: FINISH_DEBUG, arguments: '{}' })
    agent.session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'Issue is reproduced.' }], isError: false }),
    }, { surfaceOp: 'append', sourceEventSeqs: [callEvent.seq] })
    expect(projection.stateOf(agent.session, 'debug')?.logs).toEqual([])
    expect(projection.stateOf(agent.session, 'debug')?.finishDebugCallIds).toEqual([])

    // A new entry after the reset starts the next cycle.
    agent.session.append('debug/log', { step: 'save', at: '2026-09-17T10:05:00.000Z' })
    expect(projection.stateOf(agent.session, 'debug')?.logs).toEqual([
      { step: 'save', at: '2026-09-17T10:05:00.000Z' },
    ])
  })

  it('keeps the cycle after a FAILED finish_debug result', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx, 'log-window-errored')
    agent.session.append('debug/mode', { active: true })
    agent.session.append('debug/log', { step: 'save', at: '2026-09-17T10:00:00.000Z' })
    const callId = ToolCallId('window-errored')
    const callEvent = agent.session.append('tool/call', { turn: 1, step: 1, callId, name: FINISH_DEBUG, arguments: '{}' })
    agent.session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'Error: no user-questions channel' }], isError: true }),
      error: { name: 'Error', code: 'ERROR' },
    }, { surfaceOp: 'append', sourceEventSeqs: [callEvent.seq] })
    const state = ctx.sessionProjections.stateOf(agent.session, 'debug')
    expect(state?.logs).toEqual([{ step: 'save', at: '2026-09-17T10:00:00.000Z' }])
    expect(state?.finishDebugCallIds).toEqual(['window-errored'])
  })

  it('resets the cycle on a mode change and drops other tools calls and results', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx, 'log-window-mode', { active: true })
    agent.session.append('debug/log', { step: 'save', at: '2026-09-17T10:00:00.000Z' })
    const other = ToolCallId('window-other')
    const otherCall = agent.session.append('tool/call', { turn: 1, step: 1, callId: other, name: 'read', arguments: '{}' })
    agent.session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId: other, content: [{ type: 'text', text: 'ran read' }], isError: false }),
    }, { surfaceOp: 'append', sourceEventSeqs: [otherCall.seq] })
    const before = ctx.sessionProjections.stateOf(agent.session, 'debug')
    expect(before?.finishDebugCallIds).toEqual([])
    expect(before?.logs).toHaveLength(1)

    agent.session.append('debug/mode', { active: false })
    const after = ctx.sessionProjections.stateOf(agent.session, 'debug')
    expect(after?.logs).toEqual([])
    expect(after?.finishDebugCallIds).toEqual([])
    expect(after?.active).toBe(false)
  })

  it('caps the window at four thousand entries, keeping the newest', async () => {
    const events: SessionEvent[] = []
    events.push({ type: 'debug/mode', seq: SessionSeq(1), time: 0, data: { active: true } })
    for (let index = 0; index < 4001; index++) {
      events.push({
        type: 'debug/log',
        seq: SessionSeq(index + 2),
        time: index,
        data: { step: `step${index}`, at: '2026-09-17T10:00:00.000Z' },
      })
    }
    let state: DebugUnitState = debugProjectionDefinition.init()
    for (const event of events) state = debugProjectionDefinition.apply(state, event)
    expect(state.logs).toHaveLength(4000)
    expect(state.logs[0]?.step).toBe('step1')
    expect(state.logs.at(-1)?.step).toBe('step4000')
  })

  it('caps the window at the character budget, keeping the newest', async () => {
    const events: SessionEvent[] = []
    events.push({ type: 'debug/mode', seq: SessionSeq(1), time: 0, data: { active: true } })
    for (let index = 0; index < 10000; index++) {
      events.push({
        type: 'debug/log',
        seq: SessionSeq(index + 2),
        time: index,
        data: { step: 'step', at: '2026-09-17T10:00:00.000Z', data: { v: index } },
      })
    }
    let state: DebugUnitState = debugProjectionDefinition.init()
    for (const event of events) state = debugProjectionDefinition.apply(state, event)
    const chars = state.logs.reduce((sum, entry) => sum + entry.step.length + JSON.stringify(entry.data).length, 0)
    expect(chars).toBeLessThanOrEqual(256000)
    expect(state.logs.length).toBeGreaterThan(0)
  })

  it('drops the oldest entries when a single new entry exceeds the character budget', async () => {
    const events: SessionEvent[] = []
    events.push({ type: 'debug/mode', seq: SessionSeq(1), time: 0, data: { active: true } })
    // 3,600 entries at ~71 chars each fill the window near the 256,000 cap without
    // dropping anything; one oversized entry then forces oldest entries out.
    for (let index = 0; index < 3600; index++) {
      events.push({
        type: 'debug/log',
        seq: SessionSeq(index + 2),
        time: index,
        data: { step: 's', at: '2026-09-17T10:00:00.000Z', data: { pad: 'x'.repeat(60) } },
      })
    }
    let state: DebugUnitState = debugProjectionDefinition.init()
    for (const event of events) state = debugProjectionDefinition.apply(state, event)
    expect(state.logs).toHaveLength(3600)
    const before = state.logs.reduce((sum, entry) => sum + entry.step.length + JSON.stringify(entry.data).length, 0)
    expect(before).toBeLessThanOrEqual(256000)

    events.push({
      type: 'debug/log',
      seq: SessionSeq(events.length + 1),
      time: 3600,
      data: { step: 'save', at: '2026-09-17T10:00:01.000Z', data: { pad: 'y'.repeat(6000) } },
    })
    state = debugProjectionDefinition.apply(state, events[events.length - 1] as SessionEvent)
    const after = state.logs.reduce((sum, entry) => sum + entry.step.length + JSON.stringify(entry.data).length, 0)
    expect(after).toBeLessThanOrEqual(256000)
    // The newest entry survives; the oldest are dropped to make room.
    expect(state.logs.at(-1)?.step).toBe('save')
    expect(state.logs.length).toBeLessThan(3601)
  })

  it('drops no-data entries too when a single new entry exceeds the character budget', () => {
    const events: SessionEvent[] = []
    events.push({ type: 'debug/mode', seq: SessionSeq(1), time: 0, data: { active: true } })
    // Two no-data entries at the front, then 3,600 ~71-char entries with data:
    // the window is near the cap, and the no-data entries are the oldest.
    for (let index = 0; index < 2; index++) {
      events.push({ type: 'debug/log', seq: SessionSeq(index + 2), time: index, data: { step: 's', at: '2026-09-17T10:00:00.000Z' } })
    }
    for (let index = 0; index < 3600; index++) {
      events.push({
        type: 'debug/log',
        seq: SessionSeq(index + 4),
        time: index + 2,
        data: { step: 's', at: '2026-09-17T10:00:00.000Z', data: { pad: 'x'.repeat(60) } },
      })
    }
    let state: DebugUnitState = debugProjectionDefinition.init()
    for (const event of events) state = debugProjectionDefinition.apply(state, event)
    expect(state.logs).toHaveLength(3602)

    events.push({
      type: 'debug/log',
      seq: SessionSeq(events.length + 1),
      time: 3602,
      data: { step: 'save', at: '2026-09-17T10:00:01.000Z', data: { pad: 'y'.repeat(6000) } },
    })
    state = debugProjectionDefinition.apply(state, events[events.length - 1] as SessionEvent)
    // The oversized entry survives; the oldest entries (the no-data ones
    // first) drop to make room.
    expect(state.logs.at(-1)?.step).toBe('save')
    expect(state.logs[0]?.data).toBeDefined()
    const after = state.logs.reduce(
      (sum, entry) => sum + entry.step.length + (entry.data === undefined ? 0 : JSON.stringify(entry.data).length),
      0,
    )
    expect(after).toBeLessThanOrEqual(256000)
  })

  it('ignores a command/run with no args (no running intent)', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx, 'cmd-noargs')
    const before = ctx.sessionProjections.stateOf(agent.session, 'debug')
    // A command recorded without its input carries no args: it sets no intent.
    agent.session.append('command/run', { commandId: CommandId('debug'), name: 'debug', source: { kind: 'user' } })
    const after = ctx.sessionProjections.stateOf(agent.session, 'debug')
    expect(after).toEqual(before)
  })

  it('records each finish_debug call id only once', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx, 'cmd-dup')
    agent.session.append('debug/mode', { active: true })
    const callId = ToolCallId('dup-call')
    agent.session.append('tool/call', { turn: 1, step: 1, callId, name: FINISH_DEBUG, arguments: '{}' })
    // A duplicate call with the same id is ignored (recorded once, not twice).
    agent.session.append('tool/call', { turn: 1, step: 1, callId, name: FINISH_DEBUG, arguments: '{}' })
    expect(ctx.sessionProjections.stateOf(agent.session, 'debug')?.finishDebugCallIds).toEqual(['dup-call'])
    // A non-finish call is not recorded.
    const other = agent.session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('other'), name: 'read', arguments: '{}' })
    agent.session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId: ToolCallId('other'), content: [{ type: 'text', text: 'read ran' }], isError: false }),
    }, { surfaceOp: 'append', sourceEventSeqs: [other.seq] })
    expect(ctx.sessionProjections.stateOf(agent.session, 'debug')?.finishDebugCallIds).toEqual(['dup-call'])
  })

  it('exposes the cropped debug wire view through a projection snapshot', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx, 'wire-view')
    // No selection: nothing pending.
    expect(ctx.sessionProjections.snapshot(agent.session, ['debug']).values.debug).toEqual({
      active: false, pending: false, logs: [],
    })
    // A queued selection (running) whose target differs from the logged state is pending.
    agent.session.append('command/run', { commandId: CommandId('debug'), name: 'debug', args: 'crash on save', source: { kind: 'user' } })
    expect(ctx.sessionProjections.snapshot(agent.session, ['debug']).values.debug).toEqual({
      active: false, pending: true, logs: [],
    })
    // A queued selection whose target already matches the logged state is not pending.
    agent.session.append('command/run', { commandId: CommandId('debug'), name: 'debug', args: 'off', source: { kind: 'user' } })
    expect(ctx.sessionProjections.snapshot(agent.session, ['debug']).values.debug).toEqual({
      active: false, pending: false, logs: [],
    })
  })
})

describe('the soft layer', () => {
  it('keeps the tool schemas identical across default and debug mode', async () => {
    const ctx = await setup()
    registerNamedTools(ctx, ['read', 'write'])
    const agent = await agentWithSession(ctx)
    const defaultAssembly = await assembleFor(ctx, agent)
    expect(defaultAssembly.tools.map(tool => tool.name)).toEqual([FINISH_DEBUG, 'read', 'write'])
    expect(defaultAssembly.sections.find(section => section.name === 'debug:policy')?.text).toBe('')

    agent.session.append('debug/mode', { active: true })
    const debugAssembly = await assembleFor(ctx, agent)
    expect(debugAssembly.tools).toEqual(defaultAssembly.tools)
    expect(debugAssembly.sections.find(section => section.name === 'debug:policy')?.text).toBe(TEST_PROMPT)
  })

  it('leaves an agent-less assembly untouched', async () => {
    const ctx = await setup()
    registerNamedTools(ctx, ['read'])
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.tools.map(tool => tool.name)).toEqual([FINISH_DEBUG, 'read'])
    expect(assembly.sections.find(section => section.name === 'debug:policy')?.text).toBe('')
  })

  it('keeps the full toolset in debug mode and renders the configured mode section', async () => {
    const ctx = await setup()
    registerNamedTools(ctx, ['read', 'write', 'todo_write'])
    const agent = await agentWithSession(ctx, 'agent-1', { active: true })
    const assembly = await assembleFor(ctx, agent)
    expect(assembly.tools.map(tool => tool.name).sort()).toEqual([FINISH_DEBUG, 'read', 'todo_write', 'write'])
    expect(assembly.sections.find(section => section.name === 'debug:policy')?.text).toBe(TEST_PROMPT)
  })

  it('leaves foreign assemble additions alone (no assemble-layer filtering)', async () => {
    // Debug guidance does not filter the registry or later assembly additions.
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await mountProjectionSeam(ctx)
    ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const final = await next()
      final.tools = [...final.tools, { name: 'added-later', description: 'added after next()', parameters: {} }]
      return final
    })
    await ctx.plugin(DebugModeController, DEBUG_CONFIG)
    registerNamedTools(ctx, ['read'])
    const debugging = await agentWithSession(ctx, 'debugging', { active: true })
    expect((await assembleFor(ctx, debugging)).tools.map(tool => tool.name))
      .toEqual([FINISH_DEBUG, 'read', 'added-later'])
    const defaulted = await agentWithSession(ctx, 'defaulted')
    expect((await assembleFor(ctx, defaulted)).tools.map(tool => tool.name))
      .toEqual([FINISH_DEBUG, 'read', 'added-later'])
  })
})

describe('/debug', () => {
  it('registers only when a commands service is composed and steers the reported issue', async () => {
    const bare = await setup()
    expect(bare.get('commands')).toBeUndefined()

    const ctx = await setup()
    await ctx.plugin(CommandRuntime)
    // The `ctx.inject` child mounts asynchronously once `commands` resolves.
    await new Promise(resolve => setImmediate(resolve))
    const plainAgent = await agentWithSession(ctx, 'plain-debug-command')
    openTurn(plainAgent.session)
    const plainSteer = vi.fn()
    plainAgent.steer = plainSteer
    expect(ctx.commands.list(plainAgent)).toEqual([
      { definitionId: '@deepseek-ai/dsh-debug', name: 'debug', description: 'Debug a reported issue, or leave debug mode with /debug off', input: { hint: '<issue>', attachments: true } },
    ])

    const sig = signal()
    expect(await ctx.commands.execute(plainAgent, '/mode', [], sig)).toBeUndefined()
    expect(await ctx.commands.execute(plainAgent, '/review', [], sig)).toBeUndefined()

    const empty = await ctx.commands.execute(plainAgent, '/debug', [], sig)
    expect(empty?.result).toEqual({
      kind: 'error',
      text: 'provide the issue to debug, e.g. /debug the settings page crashes when saving',
    })
    expect(plainSteer).not.toHaveBeenCalled()
    expect(ctx.debug.get(plainAgent)).toEqual({ active: false })

    const run = await ctx.commands.execute(plainAgent, '/debug   the app crashes on save  ', [], sig)
    expect(run?.result).toEqual({ kind: 'success', text: 'Debugging "the app crashes on save" (applies from the next step). Use /debug off to leave.' })
    expect(ctx.debug.get(plainAgent)).toEqual({ active: false, pending: true })
    // The issue alone is steered (the workflow prompt rides the debug:policy
    // section, not the user message).
    expect(plainSteer).toHaveBeenCalledExactlyOnceWith({
      id: expect.any(String),
      role: 'user',
      content: [{ type: 'text', text: 'the app crashes on save' }],
      source: { kind: 'user' },
    })
  })

  it('leaves active debug mode, cancels a pending entry, and treats inactive exit as idempotent', async () => {
    const ctx = await setup()
    await ctx.plugin(CommandRuntime)
    await new Promise(resolve => setImmediate(resolve))
    const sig = signal()

    const inactive = await agentWithSession(ctx, 'inactive-debug-command')
    expect((await ctx.commands.execute(inactive, '/debug off', [], sig))?.result)
      .toEqual({ kind: 'success', text: 'Debug mode is already inactive.' })
    expect(ctx.debug.get(inactive)).toEqual({ active: false })

    const entering = await agentWithSession(ctx, 'entering-debug-command')
    openTurn(entering.session)
    const enteringSteer = vi.fn()
    entering.steer = enteringSteer
    await ctx.commands.execute(entering, '/debug the app crashes', [], sig)
    expect((await ctx.commands.execute(entering, '/debug off', [], sig))?.result)
      .toEqual({ kind: 'success', text: 'Debug mode entry cancelled.' })
    expect(ctx.debug.get(entering)).toEqual({ active: false, pending: false })
    await boundary(ctx, entering, 'step-start')
    expect(ctx.debug.get(entering)).toEqual({ active: false })
    expect(entering.session.snapshotEvents().some(event => event.type === 'debug/mode')).toBe(false)

    const active = await agentWithSession(ctx, 'active-debug-command', { active: true })
    openTurn(active.session)
    expect((await ctx.commands.execute(active, '/debug off', [], sig))?.result)
      .toEqual({ kind: 'success', text: 'Leaving debug mode (applies from the next step).' })
    expect(ctx.debug.get(active)).toEqual({ active: true, pending: false })
    expect((await ctx.commands.execute(active, '/debug off', [], sig))?.result)
      .toEqual({ kind: 'success', text: 'Leaving debug mode (applies from the next step).' })
    await boundary(ctx, active, 'step-start')
    expect(ctx.debug.get(active)).toEqual({ active: false })
  })

  it('idle sessions get the immediate-commit copy on both /debug and /debug off', async () => {
    const ctx = await setup()
    await ctx.plugin(CommandRuntime)
    await new Promise(resolve => setImmediate(resolve))
    const sig = signal()
    const agent = await agentWithSession(ctx, 'idle-debug-command')
    const steer = vi.fn()
    agent.steer = steer
    expect((await ctx.commands.execute(agent, '/debug the app crashes', [], sig))?.result)
      .toEqual({ kind: 'success', text: 'Debugging "the app crashes". Use /debug off to leave.' })
    expect(foldDebugMode(agent.session.snapshotEvents())).toBe(true)
    expect((await ctx.commands.execute(agent, '/debug off', [], sig))?.result)
      .toEqual({ kind: 'success', text: 'Debug mode off.' })
    expect(foldDebugMode(agent.session.snapshotEvents())).toBe(false)
  })

  it('steers the issue with attachments and refuses attachments on /debug off', async () => {
    const ctx = await setup()
    await ctx.plugin(CommandRuntime)
    await new Promise(resolve => setImmediate(resolve))
    let saved = 0
    const saveImage = (input: { mediaType: string }) => {
      saved += 1
      return Promise.resolve({ attachmentId: `att-${saved}`, mediaType: input.mediaType, bytes: 3, width: 1, height: 1 })
    }
    ctx.provide('attachments', {
      imageLimits: { maxImageBytes: 1024, maxImagesPerMessage: 4, maxMessageImageBytes: 1024, maxImagePixels: 1_000_000, mediaTypes: ['image/png'] },
      validateImage: () => Promise.resolve(),
      saveImage,
      async saveImages(inputs: readonly { mediaType: string }[]) {
        const refs = []
        for (const input of inputs) refs.push(await saveImage(input))
        return refs
      },
    } as never)
    const sig = signal()

    const agent = await agentWithSession(ctx, 'imaged-debug-command')
    openTurn(agent.session)
    const steer = vi.fn()
    agent.steer = steer
    const withMessage = await ctx.commands.execute(agent, '/debug crash on save', [
      { type: 'image' as const, mediaType: 'image/png' as const, data: 'AAAA', name: 'crash.png' },
    ], sig)
    expect(withMessage?.result.kind).toBe('success')
    expect(steer).toHaveBeenCalledExactlyOnceWith({
      id: expect.any(String),
      role: 'user',
      content: [
        { type: 'image', attachment: expect.objectContaining({ attachmentId: 'att-1' }) },
        { type: 'text', text: 'crash on save' },
      ],
      source: { kind: 'user' },
    })

    // An image without issue text still needs the issue: the error keeps the
    // attachments admitted but never steers them.
    expect((await ctx.commands.execute(agent, '/debug', [
      { type: 'image' as const, mediaType: 'image/png' as const, data: 'AAAA', name: 'crash.png' },
    ], sig))?.result).toEqual({
      kind: 'error',
      text: 'provide the issue to debug, e.g. /debug the settings page crashes when saving',
    })

    const activeAgent = await agentWithSession(ctx, 'imaged-off-debug-command', { active: true })
    expect((await ctx.commands.execute(activeAgent, '/debug off', [
      { type: 'image' as const, mediaType: 'image/png' as const, data: 'AAAA', name: 'crash.png' },
    ], sig))?.result).toEqual({ kind: 'error', text: 'Attachments cannot accompany /debug off.' })
    expect(ctx.debug.get(activeAgent)).toEqual({ active: true })
  })
})

describe('the debug-log endpoint', () => {
  async function endpointCtx() {
    const ctx = await setup()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionStore)
    return ctx
  }

  function activeSession(ctx: Context, id: string) {
    const session = ctx.sessions.create(SessionId(id))
    session.append('debug/mode', { active: true })
    return session
  }

  it('accepts a single object, an array, and NDJSON bodies as 202', async () => {
    const ctx = await endpointCtx()
    const session = activeSession(ctx, 'endpoint-bodies')
    const agent = { id: session.id, session, options: {} } as Agent
    ctx.agents.enter(agent, undefined)
    const url = await debugLogUrl(ctx, agent)
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/debug\/endpoint-bodies$/)

    const object = await fetch(url, {
      method: 'POST',
      body: JSON.stringify({ step: 'save', at: '2026-09-17T10:00:00.000Z', data: { code: 500 } }),
    })
    expect(object.status).toBe(202)

    const array = await fetch(url, {
      method: 'POST',
      body: JSON.stringify([
        { step: 'open', at: '2026-09-17T10:00:01.000Z' },
        { step: 'save', at: '2026-09-17T10:00:02.000Z', data: null },
      ]),
    })
    expect(array.status).toBe(202)

    const ndjson = await fetch(url, {
      method: 'POST',
      body: '{"step":"save","at":"2026-09-17T10:00:03.000Z"}\n{"step":"close","at":"2026-09-17T10:00:04.000Z","data":{"ok":true}}\n',
    })
    expect(ndjson.status).toBe(202)

    // An empty body and an empty batch are no-op accepts, not errors.
    const empty = await fetch(url, { method: 'POST', body: '' })
    expect(empty.status).toBe(202)
    const noEntries = await fetch(url, { method: 'POST', body: '[]' })
    expect(noEntries.status).toBe(202)

    expect(ctx.sessionProjections.stateOf(session, 'debug')?.logs).toEqual([
      { step: 'save', at: '2026-09-17T10:00:00.000Z', data: { code: 500 } },
      { step: 'open', at: '2026-09-17T10:00:01.000Z' },
      { step: 'save', at: '2026-09-17T10:00:02.000Z', data: null },
      { step: 'save', at: '2026-09-17T10:00:03.000Z' },
      { step: 'close', at: '2026-09-17T10:00:04.000Z', data: { ok: true } },
    ])
  })

  it('rejects malformed bodies with 400', async () => {
    const ctx = await endpointCtx()
    const session = activeSession(ctx, 'endpoint-malformed')
    const agent = { id: session.id, session, options: {} } as Agent
    ctx.agents.enter(agent, undefined)
    const url = await debugLogUrl(ctx, agent)
    for (const body of [
      'not json',
      JSON.stringify({ at: '2026-09-17T10:00:00.000Z' }),
      JSON.stringify({ step: '  ', at: '2026-09-17T10:00:00.000Z' }),
      JSON.stringify({ step: 'save' }),
      JSON.stringify({ step: 'save', at: 'not a date' }),
      JSON.stringify(42),
      JSON.stringify(null),
      JSON.stringify([42]),
      '{"step":"save","at":"2026-09-17T10:00:00.000Z"}\nnot json\n',
    ]) {
      const response = await fetch(url, { method: 'POST', body })
      expect(response.status).toBe(400)
    }
    expect(ctx.sessionProjections.stateOf(session, 'debug')?.logs).toEqual([])
  })

  it('rejects unknown sessions and inactive sessions with 404', async () => {
    const ctx = await endpointCtx()
    const session = activeSession(ctx, 'endpoint-inactive')
    const agent = { id: session.id, session, options: {} } as Agent
    ctx.agents.enter(agent, undefined)
    const url = await debugLogUrl(ctx, agent)

    const unknown = await fetch(url.replace(/debug\/[^/]+$/, 'debug/no-such-session'), {
      method: 'POST',
      body: JSON.stringify({ step: 'save', at: '2026-09-17T10:00:00.000Z' }),
    })
    expect(unknown.status).toBe(404)

    // An active session accepts; once the mode is off the same URL rejects.
    const active = await fetch(url, { method: 'POST', body: JSON.stringify({ step: 'save', at: '2026-09-17T10:00:00.000Z' }) })
    expect(active.status).toBe(202)
    session.append('debug/mode', { active: false })
    const inactive = await fetch(url, { method: 'POST', body: JSON.stringify({ step: 'save', at: '2026-09-17T10:00:00.000Z' }) })
    expect(inactive.status).toBe(404)
  })

  it('answers 404 for non-POST requests and non-debug paths', async () => {
    const ctx = await endpointCtx()
    const session = activeSession(ctx, 'endpoint-notfound')
    const agent = { id: session.id, session, options: {} } as Agent
    ctx.agents.enter(agent, undefined)
    const url = await debugLogUrl(ctx, agent)

    const get = await fetch(url, { method: 'GET' })
    expect(get.status).toBe(404)
    const otherPath = await fetch(url.replace(/\/debug\/[^/]+$/, '/other/session'), {
      method: 'POST',
      body: JSON.stringify({ step: 'save', at: '2026-09-17T10:00:00.000Z' }),
    })
    expect(otherPath.status).toBe(404)
    expect(ctx.sessionProjections.stateOf(session, 'debug')?.logs).toEqual([])
  })

  it('rejects bodies over the one megabyte cap with 413', async () => {
    const ctx = await endpointCtx()
    const session = activeSession(ctx, 'endpoint-oversize')
    const agent = { id: session.id, session, options: {} } as Agent
    ctx.agents.enter(agent, undefined)
    const url = await debugLogUrl(ctx, agent)
    const oversized = await fetch(url, {
      method: 'POST',
      body: JSON.stringify({ step: 'save', at: '2026-09-17T10:00:00.000Z', data: 'x'.repeat(1024 * 1024) }),
    })
    expect(oversized.status).toBe(413)
    expect(ctx.sessionProjections.stateOf(session, 'debug')?.logs).toEqual([])
  })

  it('rejects a batch over the entry cap with 429 and accepts one that fits', async () => {
    const ctx = await endpointCtx()
    const session = activeSession(ctx, 'endpoint-full')
    const agent = { id: session.id, session, options: {} } as Agent
    ctx.agents.enter(agent, undefined)
    const url = await debugLogUrl(ctx, agent)
    // 4,001 entries exceed the 4,000-entry cap; 4,000 fit.
    const tooMany = await fetch(url, {
      method: 'POST',
      body: JSON.stringify(Array.from({ length: 4001 }, (_unused, index) =>
        ({ step: 'st', at: '2026-09-17T10:00:00.000Z', data: { v: index } }))),
    })
    expect(tooMany.status).toBe(429)
    expect(ctx.sessionProjections.stateOf(session, 'debug')?.logs).toEqual([])

    const fits = await fetch(url, {
      method: 'POST',
      body: JSON.stringify(Array.from({ length: 4000 }, (_unused, index) =>
        ({ step: 'st', at: '2026-09-17T10:00:00.000Z', data: { v: index } }))),
    })
    expect(fits.status).toBe(202)
    expect(ctx.sessionProjections.stateOf(session, 'debug')?.logs).toHaveLength(4000)
  })

  it('rejects a batch over the character budget with 429', async () => {
    const ctx = await endpointCtx()
    const session = activeSession(ctx, 'endpoint-chars')
    const agent = { id: session.id, session, options: {} } as Agent
    ctx.agents.enter(agent, undefined)
    const url = await debugLogUrl(ctx, agent)
    // Each entry costs 2 (step) + 660 (data) = 662 characters; 387 entries
    // exceed the 256,000-character budget, 386 fit.
    const tooLong = await fetch(url, {
      method: 'POST',
      body: JSON.stringify(Array.from({ length: 387 },
        () => ({ step: 'st', at: '2026-09-17T10:00:00.000Z', data: { pad: 'x'.repeat(650) } }))),
    })
    expect(tooLong.status).toBe(429)
    expect(ctx.sessionProjections.stateOf(session, 'debug')?.logs).toEqual([])

    const fits = await fetch(url, {
      method: 'POST',
      body: JSON.stringify(Array.from({ length: 386 },
        () => ({ step: 'st', at: '2026-09-17T10:00:00.000Z', data: { pad: 'x'.repeat(650) } }))),
    })
    expect(fits.status).toBe(202)
    expect(ctx.sessionProjections.stateOf(session, 'debug')?.logs).toHaveLength(386)
  })

  it('closes the listener when the plugin fiber is disposed', async () => {
    const ctx = new Context()
    await mountProjectionSeam(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(DebugModeController, DEBUG_CONFIG)
    const session = ctx.sessions.create(SessionId('endpoint-dispose'))
    session.append('debug/mode', { active: true })
    const agent = { id: session.id, session, options: {} } as Agent
    ctx.agents.enter(agent, undefined)
    const url = await debugLogUrl(ctx, agent)
    const accepted = await fetch(url, { method: 'POST', body: JSON.stringify({ step: 'save', at: '2026-09-17T10:00:00.000Z' }) })
    expect(accepted.status).toBe(202)
    await fiber.dispose()
    await expect(fetch(url, { method: 'POST', body: JSON.stringify({ step: 'save', at: '2026-09-17T10:00:00.000Z' }) }))
      .rejects.toThrow()
  })
})

describe('finish_debug tool', () => {
  it('registers a stable finish tool', async () => {
    const ctx = await setup()
    expect(ctx.tools.get(FINISH_DEBUG)).toBeDefined()
    const agent = await agentWithSession(ctx)
    const missing = await execute(ctx, FINISH_DEBUG, agent)
    expect(missing.content).toEqual([{
      type: 'text',
      text: 'Error: invalid arguments: missing required property "instructions"',
    }])
    const result = await ctx.tools.execute({
      callId: ToolCallId('d-nochan'), name: FINISH_DEBUG,
      arguments: { instructions: 'Run the app.' }, signal: signal(), agent,
    })
    // No user-questions channel: the review cannot be presented.
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{
      type: 'text',
      text: 'Error: no user-questions channel is available to review the debug session; ask the user to report the outcome instead',
    }])
  })

  it('requires a calling agent and non-empty instructions', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    // No calling agent: the review cannot be routed, so it fails before any
    // side effect (no session to act on, no interaction to open).
    const noAgent = await ctx.tools.execute({
      callId: ToolCallId('d-noagent'), name: FINISH_DEBUG,
      arguments: { instructions: 'Run the app.' }, signal: signal(),
    })
    expect(noAgent.isError).toBe(true)
    expect(noAgent.content).toEqual([{
      type: 'text',
      text: 'Error: finish_debug requires a calling agent (no session to act on)',
    }])
    // Blank instructions: the schema admits the string, the tool rejects it.
    const blank = await ctx.tools.execute({
      callId: ToolCallId('d-blank'), name: FINISH_DEBUG,
      arguments: { instructions: '   ' }, signal: signal(), agent,
    })
    expect(blank.isError).toBe(true)
    expect(blank.content).toEqual([{
      type: 'text',
      text: 'Error: finish_debug requires non-empty markdown instructions',
    }])
  })

  it('treats an answer with no debug-review item as reproduced', async () => {
    const ctx = await setupWithQuestions({
      async ask() {
        return { answers: [{ id: 'unrelated', selected: ['yes'] }] } satisfies AskUserQuestionAnswer
      },
    })
    const agent = await rootAgent(ctx)
    agent.session.append('debug/mode', { active: true })
    const result = await ctx.tools.execute({
      callId: ToolCallId('d-nomatch'), name: FINISH_DEBUG,
      arguments: { instructions: 'Run the app.' }, signal: signal(), agent,
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected finish_debug success')
    // An answer that never names the debug review carries no verdict: it is a
    // reproduced continue, and the mode stays as logged (no exit is parked).
    expect(result.value).toEqual({ verdict: 'reproduced' })
    expect(ctx.debug.get(agent)).toEqual({ active: true })
  })

  it('fails when the fiber is reloaded while the review is open', async () => {
    let resolveAsked: () => void = () => {}
    const asked = new Promise<void>((resolve) => { resolveAsked = resolve })
    let resolveAnswer: (answer: AskUserQuestionAnswer) => void = () => {}
    const suspendedAnswer = new Promise<AskUserQuestionAnswer>((resolve) => { resolveAnswer = resolve })
    const ctx = new Context()
    await mountProjectionSeam(ctx)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(UserQuestionService)
    registerQuestionAnswerer(ctx, { ask: () => { resolveAsked(); return suspendedAnswer } })
    const fiber = await ctx.plugin(DebugModeController, DEBUG_CONFIG)
    const agent = await rootAgent(ctx)
    agent.session.append('debug/mode', { active: true })

    const pending = ctx.tools.execute({
      callId: ToolCallId('d-reload'), name: FINISH_DEBUG,
      arguments: { instructions: 'Run the app.' }, signal: signal(), agent,
    })
    // The reload (fiber dispose) lands while the review is still open, so the
    // verdict the user returns can no longer be trusted.
    await asked
    await fiber.dispose()
    resolveAnswer({ answers: [{ id: 'debug-review', selected: ['Proceed'] }] })
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{
      type: 'text',
      text: 'Error: the debug service was reloaded while the debug session was under review; present the instructions again',
    }])
  })

  it('presents the review call and verdict as generic cards', async () => {
    const ctx = await setup()
    const def = ctx.tools.get(FINISH_DEBUG)!
    expect(def.presentCall?.({ instructions: '# Steps\n\n1. Run the app.' })).toEqual({
      card: 'generic',
      title: 'Debug review',
      kind: 'other',
      content: [{ type: 'text', text: '# Steps\n\n1. Run the app.' }],
    })
    const content = [{ type: 'text' as const, text: 'Issue is fixed, please remove the instrumentation. Debug mode has ended.' }]
    expect(def.presentResult?.({ instructions: '# Steps' }, { content, isError: false })).toEqual({
      card: 'generic',
      title: 'Debug verdict',
      content,
    })
  })

  it('returns the cycle entries captured through the endpoint on Proceed', async () => {
    const ctx = await setupWithQuestions({
      async ask() {
        return { answers: [{ id: 'debug-review', selected: ['Proceed'] }] } satisfies AskUserQuestionAnswer
      },
    })
    const session = ctx.sessions.create(SessionId('agent-dbg-present'))
    session.append('debug/mode', { active: true })
    const agent = { id: session.id, session, options: {} } as Agent
    ctx.agents.enter(agent, undefined)
    const url = await debugLogUrl(ctx, agent)
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/debug\/agent-dbg-present$/)
    const posted = await fetch(url, {
      method: 'POST',
      body: JSON.stringify({ step: 'save', at: '2026-09-17T10:00:00.000Z', data: { code: 500 } }),
    })
    expect(posted.status).toBe(202)

    const result = await ctx.tools.execute({
      callId: ToolCallId('d-present'), name: FINISH_DEBUG,
      arguments: { instructions: 'Run the app and save a settings profile.' }, signal: signal(), agent,
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected finish_debug success')
    expect(result.value).toEqual({
      verdict: 'reproduced',
      logs: [{ step: 'save', at: '2026-09-17T10:00:00.000Z', data: { code: 500 } }],
    })
    expect(result.content).toEqual([{
      type: 'text',
      text: 'Issue is reproduced, please continue. The captured log entries are in this result:\n'
        + '{"at":"2026-09-17T10:00:00.000Z","step":"save","data":{"code":500}}',
    }])
    // Proceed keeps the session in debug mode (the single mode event is the
    // entry). The loop appends the tool/result after the tool returns; that
    // event resets the captured cycle so the next finish_debug starts clean.
    expect(ctx.sessionProjections.stateOf(agent.session, 'debug')?.active).toBe(true)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'debug/mode')).toHaveLength(1)
    expect(ctx.sessionProjections.stateOf(agent.session, 'debug')?.logs).toEqual([
      { step: 'save', at: '2026-09-17T10:00:00.000Z', data: { code: 500 } },
    ])
    const callEvent = agent.session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('d-present'), name: FINISH_DEBUG, arguments: '{}' })
    agent.session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId: ToolCallId('d-present'), content: result.content, isError: false }),
    }, { surfaceOp: 'append', sourceEventSeqs: [callEvent.seq] })
    expect(ctx.sessionProjections.stateOf(agent.session, 'debug')?.logs).toEqual([])
  })

  it('returns a Proceed result without logs when nothing was captured', async () => {
    const ctx = await setupWithQuestions({
      async ask() {
        return { answers: [{ id: 'debug-review', selected: ['Proceed'] }] } satisfies AskUserQuestionAnswer
      },
    })
    const agent = await rootAgent(ctx)
    agent.session.append('debug/mode', { active: true })

    const result = await ctx.tools.execute({
      callId: ToolCallId('d-absent'), name: FINISH_DEBUG,
      arguments: { instructions: 'Run the app.' }, signal: signal(), agent,
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected finish_debug success')
    expect(result.value).toEqual({ verdict: 'reproduced' })
    expect(result.content).toEqual([{
      type: 'text',
      text: 'Issue is reproduced, please continue. No log entries were captured — the user may not have run the steps, or the instrumentation failed.',
    }])
  })

  it('renders a captured entry without data as at/step JSON only', async () => {
    const ctx = await setupWithQuestions({
      async ask() {
        return { answers: [{ id: 'debug-review', selected: ['Proceed'] }] } satisfies AskUserQuestionAnswer
      },
    })
    const agent = await rootAgent(ctx)
    agent.session.append('debug/mode', { active: true })
    agent.session.append('debug/log', { step: 'open', at: '2026-09-17T10:00:00.000Z' })

    const result = await ctx.tools.execute({
      callId: ToolCallId('d-nodata'), name: FINISH_DEBUG,
      arguments: { instructions: 'Run the app.' }, signal: signal(), agent,
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected finish_debug success')
    expect(result.content).toEqual([{
      type: 'text',
      text: 'Issue is reproduced, please continue. The captured log entries are in this result:\n'
        + '{"at":"2026-09-17T10:00:00.000Z","step":"open"}',
    }])
  })

  it('marks fixed, parks the un-narrated exit for the next boundary, and resets the cycle', async () => {
    const ctx = await setupWithQuestions({
      async ask() {
        return { answers: [{ id: 'debug-review', selected: ['Mark as fixed'] }] } satisfies AskUserQuestionAnswer
      },
    })
    // A real in-turn tool call: an open turn whose step boundary then flushes
    // the exit selection the tool parked.
    const session = ctx.sessions.create(SessionId('agent-dbg-fixed'))
    session.append('debug/mode', { active: true })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const agent = { id: session.id, session, options: {} } as Agent
    ctx.agents.enter(agent, undefined)
    const url = await debugLogUrl(ctx, agent)
    await fetch(url, { method: 'POST', body: JSON.stringify({ step: 'save', at: '2026-09-17T10:00:00.000Z' }) })

    const result = await ctx.tools.execute({
      callId: ToolCallId('d-fixed'), name: FINISH_DEBUG,
      arguments: { instructions: 'Run the app and save a settings profile.' }, signal: signal(), agent,
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected finish_debug success')
    expect(result.value).toEqual({ verdict: 'fixed' })
    expect(result.content).toEqual([{
      type: 'text',
      text: 'Issue is fixed, please remove the instrumentation. Debug mode has ended.',
    }])
    // The exit selection parks while the turn is open (only the entry event is
    // logged) and the next accepted step boundary appends it — the session is
    // off, and the exit is not narrated (the tool result already did).
    expect(session.snapshotEvents().filter(event => event.type === 'debug/mode')).toHaveLength(1)
    await boundary(ctx, agent, 'step-start')
    expect(session.snapshotEvents().filter(event => event.type === 'debug/mode').map(event => event.data.active)).toEqual([true, false])
    expect(foldDebugMode(session.snapshotEvents())).toBe(false)
    expect(noticeTexts(session)).toEqual([])
  })

  it('treats a custom or unexpected answer as reproduced (never fixed)', async () => {
    const ctx = await setupWithQuestions({
      async ask() {
        return { answers: [{ id: 'debug-review', selected: ['Mark as fixed'], custom: 'almost' }] } satisfies AskUserQuestionAnswer
      },
    })
    const agent = await rootAgent(ctx)
    agent.session.append('debug/mode', { active: true })

    const result = await ctx.tools.execute({
      callId: ToolCallId('d-custom'), name: FINISH_DEBUG,
      arguments: { instructions: 'Run the app.' }, signal: signal(), agent,
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected finish_debug success')
    // A custom answer is a "not a clean mark-fixed" — proceed, and the mode
    // stays as logged (no exit intent is parked).
    expect(result.value).toEqual({ verdict: 'reproduced' })
    expect(ctx.debug.get(agent)).toEqual({ active: true })
  })

  it('surfaces a dismissed review as a stop-and-wait error', async () => {
    const ctx = await setupWithQuestions({
      async ask() {
        throw new UserQuestionError('the user cancelled ask_user_question', 'ASK_CANCELLED')
      },
    })
    const agent = await rootAgent(ctx)
    agent.session.append('debug/mode', { active: true })

    const result = await ctx.tools.execute({
      callId: ToolCallId('d-dismiss'), name: FINISH_DEBUG,
      arguments: { instructions: 'Run the app.' }, signal: signal(), agent,
    })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{
      type: 'text',
      text: 'Error: The user dismissed the debug review to speak instead; keep the instrumentation in place, stop here, and wait for their message.',
    }])
  })

  it('reports the pass-through abort message when the review is aborted', async () => {
    const ctx = await setupWithQuestions({
      async ask() {
        throw new UserQuestionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED')
      },
    })
    const agent = await rootAgent(ctx)
    agent.session.append('debug/mode', { active: true })

    const result = await ctx.tools.execute({
      callId: ToolCallId('d-abort'), name: FINISH_DEBUG,
      arguments: { instructions: 'Run the app.' }, signal: signal(), agent,
    })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{
      type: 'text',
      text: 'Error: ask_user_question was aborted before the user answered',
    }])
  })

  it('succeeds without a filesystem (the endpoint replaces file capture)', async () => {
    // finish_debug no longer touches the workspace: a composition without a
    // filesystem behaves like one with.
    const ctx = await setupWithQuestions({
      async ask() {
        return { answers: [{ id: 'debug-review', selected: ['Proceed'] }] } satisfies AskUserQuestionAnswer
      },
    })
    const agent = await rootAgent(ctx)
    agent.session.append('debug/mode', { active: true })
    const result = await ctx.tools.execute({
      callId: ToolCallId('d-nofs'), name: FINISH_DEBUG,
      arguments: { instructions: 'Run the app.' }, signal: signal(), agent,
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected finish_debug success')
    expect(result.value).toEqual({ verdict: 'reproduced' })
  })

  it('unregisters the tool when its plugin fiber is disposed', async () => {
    const ctx = new Context()
    await mountProjectionSeam(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = await ctx.plugin(DebugModeController, DEBUG_CONFIG)
    expect(ctx.tools.get(FINISH_DEBUG)).toBeDefined()
    await fiber.dispose()
    expect(ctx.tools.get(FINISH_DEBUG)).toBeUndefined()
  })
})
