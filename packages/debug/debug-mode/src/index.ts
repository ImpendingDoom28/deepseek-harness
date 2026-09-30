/**
 * Debug mode is logged per-agent collaboration state: while active, a
 * deployment-owned workflow section is included in each model request, and
 * `finish_debug` blocks on a `debug-review` decision card — Proceed keeps the
 * session in debug mode and returns the cycle's captured log entries, Mark as
 * fixed ends the session. The `/debug <issue>` command starts a session
 * (steering the reported issue), and `/debug off` leaves it.
 *
 * Instrumentation logs by POSTing entries to a loopback debug-log endpoint the
 * service listens on for its lifetime; accepted entries are appended as
 * `debug/log` session events. The `debug` projection folds the session log, so
 * resume and fork restore the state, and the current cycle's entries travel in
 * the projection the finish tool reads. User selections remain pending until
 * the next accepted in-turn pre-step. The service includes the selected state
 * in the proposed step assembly, then appends `debug/mode` from
 * `agent/pre-step` only when the step is accepted. Same-step request retries
 * reuse their assembly.
 *
 * The finish tool stays registered while debug mode is inactive, so entering
 * or leaving debug mode changes only the prompt section, not the request tool
 * catalog.
 *
 * @module @deepseek-ai/dsh-debug
 */

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context, Service } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type { CommandDefinitionId, CommandId } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { DebugLogEntry, DebugProjection, DebugUnitState } from './types.ts'
export type * from './types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * A mode-switch narration appended by `dsh-debug` at the boundary that
     * commits a user selection. Readers preserve the message without the
     * producer; its content is model-facing and the kind is attribution only
     * (no projection reads it).
     * @persistenceAttribution
     */
    'debug-mode': { kind: 'debug-mode' } & ContextFormed
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Whether debug mode is in force from this point on: log-only, non-surface,
     * whole-value replace. The last `debug/mode` wins; a log with none folds to
     * inactive through the projection unit's fold.
     */
    'debug/mode': { active: boolean }
    /**
     * One instrumentation log entry captured for the current debug cycle,
     * appended from the loopback debug-log endpoint: log-only, non-surface,
     * order-preserving. `data` is the free-form diagnostic payload, absent
     * when the entry carried none.
     *
     * @param step - the step name the entry was captured at (non-empty).
     * @param at - the entry's timestamp, a string the host parses as a date.
     * @param data - the free-form diagnostic payload, if any.
     */
    'debug/log': { step: string; at: string; data?: JsonValue }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    debug: DebugModeController
  }
}

/** The model-facing finish tool's name. */
export const FINISH_DEBUG = 'finish_debug'

/** The review question's id, echoed in the answer this tool reads. */
const REVIEW_ID = 'debug-review'

/** The review question's Proceed option label. */
const PROCEED_LABEL = 'Proceed'

/** The review question's Mark-as-fixed option label. */
const MARK_AS_FIXED_LABEL = 'Mark as fixed'

const FINISH_DESCRIPTION
  = 'Use only during a debug session, once you have added instrumentation that POSTs log entries to the debug log endpoint. '
  + 'Pass the COMPLETE steps to reproduce the issue as an ordered list — nothing else: no prose, no context, '
  + 'and no notes on what to look for in the captured log entries. The user then chooses Proceed (the issue is '
  + 'reproduced; the captured entries come back as this tool\'s result) or Mark as fixed (the issue is resolved; '
  + 'remove the debug instrumentation while preserving the fix). Their choice comes back as this tool\'s result; '
  + 'act on it. Make this the only and final tool call in that assistant response.'

/**
 * The current cycle's captured-entry window: entries are retained newest-first
 * within these bounds so the finish tool's result stays bounded. Protocol
 * constants, not tunables.
 */
const LOGS_MAX_ENTRIES = 4000
/** Character budget over `step + JSON.stringify(data)` across the window. */
const LOGS_MAX_CHARS = 256000
/** The debug-log endpoint's maximum request body. */
const LOGS_MAX_BODY = 1024 * 1024

const REVIEW_QUESTION = 'How did the issue behave when you ran the steps above?'

/**
 * Deployment-owned debug workflow guidance.
 */
export interface DebugModeConfig {
  /**
   * The debug workflow prompt, rendered as the `debug:policy` prompt section
   * while debug mode is active. Required and non-empty; unknown keys fail at
   * load.
   */
  prompt: string
}

/**
 * Validate deployment-owned debug workflow guidance. Missing, blank, non-string,
 * or unknown fields fail at plugin load rather than being ignored.
 *
 * @param config Raw plugin config.
 * @returns A detached validated config.
 */
export function resolveConfig(config: DebugModeConfig): DebugModeConfig {
  const prompt = (config as Partial<DebugModeConfig>).prompt
  if (typeof prompt !== 'string') {
    throw new Error('DebugModeConfig needs a string `prompt`')
  }
  if (prompt.trim() === '') {
    throw new Error('DebugModeConfig needs a non-empty `prompt`')
  }
  const unknown = Object.keys(config).filter(key => key !== 'prompt')
  if (unknown.length > 0) {
    throw new Error(`DebugModeConfig has unknown key(s) ${unknown.join(', ')} — config is { prompt }`)
  }
  return { prompt }
}

/**
 * One captured log entry, wire-validated by a predicate that mirrors
 * `parseEntries` (non-empty `step`, parseable `at`, lossless-JSON or absent
 * `data`). `zod.custom<DebugLogEntry>` yields the entry type directly, so the
 * optional `data` needs no cast under `exactOptionalPropertyTypes`.
 */
const debugLogEntrySchema: ZodType<DebugLogEntry> = zod.custom<DebugLogEntry>((value) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const step = record.step
  const at = record.at
  if (typeof step !== 'string' || step.trim() === '') return false
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return false
  return record.data === undefined || zod.json().safeParse(record.data).success
})

/* jscpd:ignore-start -- logged-mode companion mirrors plan-mode's unit-state schema */
const debugUnitStateSchema: ZodType<DebugUnitState> = zod.object({
  active: zod.boolean(),
  wanted: zod.boolean().nullable(),
  running: zod.object({
    commandId: zod.custom<CommandId>(value => typeof value === 'string'),
    wanted: zod.boolean(),
  }).strict().nullable(),
  activeAtLastHeader: zod.boolean().nullable(),
  logs: zod.array(debugLogEntrySchema),
  finishDebugCallIds: zod.array(zod.string()),
}).strict()
/* jscpd:ignore-end */

/** Wire payload schema of the `debug` projection. */
const debugProjectionSchema: ZodType<DebugProjection> = zod.object({
  active: zod.boolean(),
  pending: zod.boolean(),
  logs: zod.array(debugLogEntrySchema),
})

/** Fold one `debug/log` event into the cycle window (newest kept within the caps). */
function appendLogEntry(state: DebugUnitState, entry: DebugLogEntry): DebugUnitState {
  const logs = [...state.logs, entry]
  while (logs.length > LOGS_MAX_ENTRIES) logs.shift()
  let chars = 0
  for (const item of logs) chars += item.step.length + (item.data === undefined ? 0 : JSON.stringify(item.data).length)
  // The guard leaves at least the newest entry, so each `shift()` returns one;
  // the loop re-checks before each drop to stop at the newest.
  while (logs.length > 1 && chars > LOGS_MAX_CHARS) {
    const dropped = logs.shift() as DebugLogEntry
    chars -= dropped.step.length + (dropped.data === undefined ? 0 : JSON.stringify(dropped.data).length)
  }
  return { ...state, logs }
}

/** Projection of logged debug selections, committed mode, and captured entries. */
export const debugProjectionDefinition = {
  key: 'debug',
  stateVersion: 2,
  stateSchema: debugUnitStateSchema,
  init: () => ({
    active: false,
    wanted: null,
    running: null,
    activeAtLastHeader: null,
    logs: [] as DebugLogEntry[],
    finishDebugCallIds: [] as string[],
  }),
  apply: (state, event) => {
    /* jscpd:ignore-start -- logged-mode companion mirrors plan-mode's command fold branches */
    if (event.type === 'command/run' && event.data.name === 'debug') {
      if (event.data.args === undefined) return state
      const wanted = event.data.args.trim() !== 'off'
      return { ...state, running: { commandId: event.data.commandId, wanted } }
    }
    if (event.type === 'command/done' && event.data.commandId === state.running?.commandId) {
      const wanted = event.data.kind === 'success' && state.running.wanted !== state.active
        ? state.running.wanted
        : null
      return { ...state, wanted, running: null }
    }
    /* jscpd:ignore-end */
    if (event.type === 'debug/mode') {
      // A mode change opens a new cycle: the next finish_debug starts clean.
      return { ...state, active: event.data.active, wanted: null, logs: [], finishDebugCallIds: [] }
    }
    if (event.type === 'debug/log') {
      const { step, at, data } = event.data
      const entry: DebugLogEntry = { step, at, ...(data === undefined ? {} : { data }) }
      return appendLogEntry(state, entry)
    }
    if (event.type === 'tool/call') {
      if (event.data.name !== FINISH_DEBUG) return state
      if (state.finishDebugCallIds.includes(event.data.callId)) return state
      return { ...state, finishDebugCallIds: [...state.finishDebugCallIds, event.data.callId] }
    }
    if (event.type === 'tool/result') {
      const callId = event.data.message.toolCallId
      if (!state.finishDebugCallIds.includes(callId)) return state
      // A failed finish_debug is not a verdict: its cycle is not reset.
      if (event.data.message.isError !== true) {
        return {
          ...state,
          logs: [],
          finishDebugCallIds: state.finishDebugCallIds.filter(id => id !== callId),
        }
      }
      return state
    }
    if (event.type === 'request/header') {
      return { ...state, activeAtLastHeader: state.active }
    }
    return state
  },
  wire: {
    viewSchema: debugProjectionSchema,
    view: (state) => {
      const wanted = state.running?.wanted ?? state.wanted
      return { active: state.active, pending: wanted !== null && wanted !== state.active, logs: state.logs }
    },
  },
} satisfies ProjectionDefinition<'debug', DebugUnitState>

/**
 * `ctx.debug`: owns logged debug state, applies and narrates selected state at
 * step start, the `debug:policy` section, the loopback debug-log endpoint, the
 * `/debug` command, and the `finish_debug` tool. Client carriers expose the
 * projection's cropped `{ active, pending, logs }` view.
 */
export class DebugModeController extends Service {
  static inject = ['tools', 'systemPrompt', 'sessionProjections']

  /** Validated deployment-owned workflow prompt. */
  private readonly prompt: string

  /** The loopback debug-log port, known once the service init binds the socket. */
  private port: number | undefined

  /**
   * Latest selection per session awaiting the next accepted in-turn pre-step.
   * `narrate` is true for user selections and false for the finish tool, whose
   * result already narrates the transition.
   */
  private readonly pendingIntents = new WeakMap<Session, { active: boolean; narrate: boolean }>()

  constructor(ctx: Context, config: DebugModeConfig = { prompt: '' }) {
    super(ctx, 'debug')
    this.prompt = resolveConfig(config).prompt
    /* jscpd:ignore-start -- logged-mode companion mirrors plan-mode's pre-step selection listener */
    let disposed = false
    // Pre-step is outside Session.append publication, so it can append the
    // log-only mode event inside an open turn without re-entering the session.
    // A failed append remains pending for a later accepted in-turn pre-step,
    // and policy cannot block the step.
    ctx.on('agent/pre-step', async (
      { agent, signal },
      next,
    ): Promise<PreStepDecision> => {
      const decision = await next()
      const pending = this.pendingIntents.get(agent.session)
      if (decision.kind === 'reject' || signal.aborted || pending === undefined) return decision
      const narration = this.narration(agent.session, pending.active)
      try {
        this.onBoundary(agent.session)
      } catch (error) {
        ctx.logger.warn('dsh-debug: failed to append selected debug mode at step start: %o', error)
        return decision
      }
      return !pending.narrate || narration === undefined
        ? decision
        : { ...decision, messages: [...decision.messages, narration] }
    })
    /* jscpd:ignore-end */
    ctx.effect(() => () => { disposed = true }, 'dsh-debug: close service lifetime')

    ctx.systemPrompt.section({
      name: 'debug:policy',
      order: ctx.systemPrompt.getSectionOrder('DEBUG_POLICY'),
      text: (context) => {
        if (context.agent === undefined || this.port === undefined) return ''
        const pending = this.pendingIntents.get(context.agent.session)
        return (pending?.active ?? this.loggedActive(context.agent.session)) ? this.prompt : ''
      },
    })

    ctx.systemPrompt.variable('debug_log_url', (context) => {
      if (context.agent === undefined || this.port === undefined) return undefined
      return `http://127.0.0.1:${this.port}/debug/${context.agent.session.id}`
    })

    ctx.sessionProjections.register(debugProjectionDefinition)

    // The command child activates only when a command registry is composed.
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        definitionId: brandString<CommandDefinitionId>('@deepseek-ai/dsh-debug'),
        name: 'debug',
        description: 'Debug a reported issue, or leave debug mode with /debug off',
        input: { hint: '<issue>', attachments: true },
        handler: ({ agent, rawInput, attachments }) => {
          const issue = rawInput.trim()
          if (issue === 'off' && attachments.length > 0) {
            return { kind: 'error', text: 'Attachments cannot accompany /debug off.' }
          }
          if (issue === 'off') {
            switch (this.set(agent, false)) {
              case 'committed':
                return { kind: 'success', text: 'Debug mode off.' }
              case 'queued':
                return { kind: 'success', text: 'Leaving debug mode (applies from the next step).' }
              case 'cancelled':
                return { kind: 'success', text: 'Debug mode entry cancelled.' }
              case 'noop':
                // Repeat the queued wording while an exit still awaits the
                // next accepted pre-step; only a truly inactive session reads
                // idempotent.
                return this.loggedActive(agent.session)
                  ? { kind: 'success', text: 'Leaving debug mode (applies from the next step).' }
                  : { kind: 'success', text: 'Debug mode is already inactive.' }
            }
          }
          if (issue === '') {
            return { kind: 'error', text: 'provide the issue to debug, e.g. /debug the settings page crashes when saving' }
          }
          const outcome = this.set(agent, true)
          agent.steer(createUserMessage({
            content: [
              ...attachments,
              { type: 'text' as const, text: issue },
            ],
            source: { kind: 'user' },
          }))
          return {
            kind: 'success',
            text: outcome === 'committed'
              ? `Debugging "${issue}". Use /debug off to leave.`
              : `Debugging "${issue}" (applies from the next step). Use /debug off to leave.`,
          }
        },
      })
    })

    ctx.tools.register(defineTool({
      name: FINISH_DEBUG,
      description: FINISH_DESCRIPTION,
      parameters: {
        instructions: { type: 'string', required: true, description: 'The complete steps to reproduce the issue, as an ordered list — nothing else.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            verdict: { type: 'string', enum: ['reproduced', 'fixed'], required: true },
            logs: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  at: { type: 'string', description: 'The entry timestamp as reported by the instrumentation.' },
                  step: { type: 'string', description: 'The step name the entry was captured at.' },
                  data: { type: 'json', description: 'Free-form diagnostic payload; absent when the entry carried none.' },
                },
              },
            },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.verdict === 'fixed'
            ? 'Issue is fixed, please remove the instrumentation. Debug mode has ended.'
            : value.logs === undefined || value.logs.length === 0
              ? 'Issue is reproduced, please continue. No log entries were captured — the user may not have run the steps, or the instrumentation failed.'
              : 'Issue is reproduced, please continue. The captured log entries are in this result:\n'
                + value.logs.map(entry => entry.data === undefined
                  ? JSON.stringify({ at: entry.at, step: entry.step })
                  : JSON.stringify({ at: entry.at, step: entry.step, data: entry.data })).join('\n'),
        }],
      },
      execute: async (args, exec) => {
        const agent = exec.agent
        // `exec.agent` is optional on the execution input, but `ask` needs the
        // calling agent to route the review; fail before any side effect.
        if (agent === undefined) throw new Error(`${FINISH_DEBUG} requires a calling agent (no session to act on)`)
        if (args.instructions.trim() === '') {
          throw new Error(`${FINISH_DEBUG} requires non-empty markdown instructions`)
        }
        const interaction = ctx.get('userQuestions')
        if (interaction === undefined) {
          throw new Error('no user-questions channel is available to review the debug session; ask the user to report the outcome instead')
        }
        const answer = await interaction.ask({
          questions: [{
            id: REVIEW_ID,
            header: 'Debug',
            question: REVIEW_QUESTION,
            detail: args.instructions,
            options: [
              { label: PROCEED_LABEL, description: 'The issue is reproduced; the captured entries come back as this result.' },
              { label: MARK_AS_FIXED_LABEL, description: 'The issue is fixed; remove the debug instrumentation.' },
            ],
            // Presentation only: a capable UI renders the debug review as a
            // decision card instead of a generic question, and answers with one
            // of the labels above either way.
            intent: { kind: 'debug-review', approve: PROCEED_LABEL },
          }],
          agent,
          signal: exec.signal,
        }).catch((cause: unknown) => {
          // A dismissed review is not a failed one: the user took the turn back
          // to say something the two options do not cover. Say so, because the
          // generic channel message names the question channel, which the model
          // never called. An abort keeps its own message.
          if (cause instanceof UserQuestionError && cause.code === 'ASK_CANCELLED') {
            throw new Error('The user dismissed the debug review to speak instead; '
              + 'keep the instrumentation in place, stop here, and wait for their message.')
          }
          throw cause
        })
        // A review may outlive this plugin fiber. Without its lifetime the
        // verdict could not be trusted, so fail and ask to present again.
        if (disposed) {
          throw new Error('the debug service was reloaded while the debug session was under review; present the instructions again')
        }
        const reviewItems = answer.answers.filter(entry => entry.id === REVIEW_ID)
        const item = reviewItems.length === 1 ? reviewItems[0] : undefined
        const verdict: 'reproduced' | 'fixed' = item?.selected.length === 1 && item.selected[0] === MARK_AS_FIXED_LABEL && item.custom === undefined
          ? 'fixed'
          : 'reproduced'
        if (verdict === 'fixed') {
          // Keep the mode for the rest of this assistant tool batch; the
          // selection is appended at the next accepted in-turn pre-step. The
          // tool result already narrates the transition, so no switch notice.
          this.pendingIntents.set(agent.session, { active: false, narrate: false })
          return { verdict }
        }
        const logs = this.debugState(agent.session).logs
        return { verdict, ...(logs.length === 0 ? {} : { logs }) }
      },
      presentCall: args => ({
        card: 'generic',
        title: 'Debug review',
        kind: 'other',
        content: [{ type: 'text', text: args.instructions }],
      }),
      presentResult: (_args, result) => ({
        card: 'generic',
        title: 'Debug verdict',
        content: result.content,
      }),
    }))
  }

  /** Listen on the loopback debug-log endpoint for the service lifetime. */
  async [Service.init](): Promise<void> {
    const ctx = this.ctx
    const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      /* v8 ignore next -- node:http always sets url on server requests. */
      const url = new URL(req.url ?? '/', 'http://x')
      const match = /^\/debug\/(.+)$/.exec(url.pathname)
      if (req.method !== 'POST' || match === null) {
        this.respond(res, 404, 'Not found')
        return
      }
      const id = match[1]
      /* v8 ignore next 3 -- `(.+)` guarantees a non-empty capture on a matched path. */
      if (id === undefined) {
        this.respond(res, 404, 'Not found')
        return
      }
      const sessions = ctx.get('sessions')
      const session = sessions?.get(SessionId(id))
      if (session === undefined) {
        this.respond(res, 404, 'unknown session')
        return
      }
      const debug = ctx.get('debug')
      if (debug === undefined || !this.debugState(session).active) {
        this.respond(res, 404, 'debug mode is not active for this session')
        return
      }
      const body = await this.readBody(req, res)
      if (body === null) return
      const entries = this.parseEntries(body)
      if (entries === null) {
        this.respond(res, 400, 'malformed debug-log body')
        return
      }
      const state = this.debugState(session)
      if (state.logs.length + entries.length > LOGS_MAX_ENTRIES || this.logChars(state.logs) + this.logChars(entries) > LOGS_MAX_CHARS) {
        this.respond(res, 429, 'debug-log window is full')
        return
      }
      for (const entry of entries) {
        session.append('debug/log', entry)
      }
      this.respond(res, 202, 'accepted')
    }
    const server = createServer((req, res) => {
      // Last-resort guard: a per-request fault logs and answers 400, never a
      // process exit.
      /* v8 ignore start -- last-resort containment for Node response failures after validated inputs */
      void handle(req, res).catch((error: unknown) => {
        ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
        if (res.headersSent) {
          res.destroy()
          return
        }
        this.respond(res, 400, 'bad request')
      })
      /* v8 ignore stop */
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        this.port = (server.address() as AddressInfo).port
        resolve()
      })
    })
    ctx.effect(() => async () => {
      const closed = new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      server.closeAllConnections()
      await closed
      this.port = undefined
    }, 'dsh-debug: close debug-log endpoint')
  }

  /**
   * Write one fixed debug-log response. The caller answers before any further
   * body handling, so a short-circuit leaves the request complete.
   *
   * @param res The response to finish.
   * @param status The HTTP status.
   * @param body The plain-text response body.
   */
  private respond(res: ServerResponse, status: number, body: string): void {
    res.writeHead(status, { 'content-type': 'text/plain' })
    res.end(body)
  }

  /**
   * Read the request body up to the cap. Answers 413 and resolves `null` when
   * it would exceed the cap; resolves the decoded text otherwise.
   *
   * @param req The request whose body is read.
   * @param res The response, used to answer the oversize rejection.
   * @returns the body text, or `null` when the request was rejected.
   */
  private async readBody(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length
      if (size > LOGS_MAX_BODY) {
        this.respond(res, 413, 'request body too large')
        return null
      }
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  /**
   * Parse one JSON object or NDJSON body into validated log entries.
   *
   * @param body The decoded request body.
   * @returns the entries, or `null` when the body is not valid debug-log JSON.
   */
  private parseEntries(body: string): DebugLogEntry[] | null {
    const text = body.trim()
    if (text === '') return []
    // A body opening with `[` is one JSON array of entries. A body with newlines
    // is NDJSON (one object per line). Anything else is a single JSON object.
    const list: unknown[] = text.startsWith('[')
      ? JSON.parse(text)
      : text.includes('\n')
        ? text.split('\n').map(line => JSON.parse(line))
        : [JSON.parse(text)]
    if (list.length === 0) return []
    const entries: DebugLogEntry[] = []
    for (const item of list) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return null
      const record = item as Record<string, unknown>
      const step = record.step
      const at = record.at
      if (typeof step !== 'string' || step.trim() === '') return null
      if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return null
      const data = record.data
      const entry: DebugLogEntry = { step, at }
      if (data !== undefined) entry.data = data as JsonValue
      entries.push(entry)
    }
    return entries
  }

  /** Sum the window's character usage over `step + JSON.stringify(data)`. */
  private logChars(logs: readonly DebugLogEntry[]): number {
    return logs.reduce((sum, entry) => sum + entry.step.length + (entry.data === undefined ? 0 : JSON.stringify(entry.data).length), 0)
  }

  private loggedActive(session: Session): boolean {
    return this.debugState(session).active
  }

  private hasOpenTurn(session: Session): boolean {
    const state = this.ctx.sessionProjections.stateOf(session, 'turnBoundary')
    if (state === undefined) throw new Error('debug-mode requires the turnBoundary session projection')
    return state.openTurnStartSeq !== null
  }

  private loggedActiveAtLastHeader(session: Session): boolean | undefined {
    return this.debugState(session).activeAtLastHeader ?? undefined
  }

  /* jscpd:ignore-start -- logged-mode companion mirrors plan-mode's projection-state and selection state machine */
  /** Read the required debug projection state or fail at the first service access. */
  private debugState(session: Session): DebugUnitState {
    const state = this.ctx.sessionProjections.stateOf(session, 'debug')
    /* v8 ignore next -- the controller registers the debug projection at construction, so stateOf always returns a state. */
    if (state === undefined) throw new Error('debug-mode requires the debug session projection')
    return state
  }

  /**
   * Read the logged debug state and any selected state awaiting the next
   * accepted in-turn pre-step.
   *
   * @param agent The agent to read.
   * @returns Current logged state plus a pending selection, when present.
   */
  get(agent: Agent): { active: boolean; pending?: boolean } {
    const active = this.loggedActive(agent.session)
    const pending = this.pendingIntents.get(agent.session)
    return pending === undefined ? { active } : { active, pending: pending.active }
  }

  /**
   * Select whether debug mode should be active. Between turns the method
   * appends the change immediately because no in-turn pre-step will run until
   * another prompt starts a turn. The open-turn fold is the idle signal:
   * agent status stays `running` through post-turn checkpointing, when no
   * further in-turn pre-step runs. During an open turn the selection remains
   * pending until the next accepted in-turn pre-step. Repeated selection of
   * the current or already-pending state is a no-op.
   *
   * @param agent The agent to switch.
   * @param active Whether debug mode should be active.
   * @returns what happened: `committed` (logged now), `queued` (awaiting the
   * next accepted in-turn pre-step), `cancelled` (an opposite pending selection
   * was cleared; the logged state already matches), or `noop` (already in that
   * state).
   */
  set(agent: Agent, active: boolean): 'committed' | 'queued' | 'cancelled' | 'noop' {
    const session = agent.session
    const pending = this.pendingIntents.get(session)
    const target = pending?.active ?? this.loggedActive(session)
    if (active === target) return 'noop'
    if (this.hasOpenTurn(session)) {
      this.pendingIntents.set(session, { active, narrate: true })
      return this.loggedActive(session) === active ? 'cancelled' : 'queued'
    }
    // No open turn: commit now. Delete only after append succeeds so a
    // failed durable write leaves the selection retryable, not dropped.
    if (active === this.loggedActive(session)) {
      this.pendingIntents.delete(session)
      return 'cancelled'
    }
    session.append('debug/mode', { active })
    this.pendingIntents.delete(session)
    const narration = this.narration(session, active)
    if (narration !== undefined) agent.inject(narration)
    return 'committed'
  }

  /** Append one pending selection before the next request assembly. */
  private onBoundary(session: Session): void {
    const pending = this.pendingIntents.get(session)
    if (pending === undefined) return
    const target = pending.active
    if (target === this.loggedActive(session)) {
      this.pendingIntents.delete(session)
      return
    }
    session.append('debug/mode', { active: target })
    // Delete only after append succeeds so a later accepted in-turn pre-step
    // can retry a failed durable write.
    this.pendingIntents.delete(session)
  }
  /* jscpd:ignore-end */


  /** Build a user-switch notice when the last logged header described the other mode. */
  private narration(session: Session, target: boolean): UserMessage | undefined {
    const told = this.loggedActiveAtLastHeader(session)
    if (told === undefined || told === target) return
    const text = target
      ? 'The user switched this session to debug mode.'
      : 'The user switched this session back to the default mode.'
    return createUserMessage({
      content: [{ type: 'text', text }],
      // The narration is already one sentence, so it is its own summary.
      source: { kind: 'debug-mode', form: 'notice', summary: text },
    })
  }
}

export default DebugModeController
