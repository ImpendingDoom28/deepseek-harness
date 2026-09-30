/**
 * Pure types of the debug domain: the ONE home of the `debug` projection-key
 * declaration, free of this package's host-side value imports (cordis,
 * dsh-tools, dsh-agent). Two namespace projections serve it — `./types` for
 * host consumers and `./client` for client aggregates — with zero content
 * duplication.
 *
 * @module @deepseek-ai/dsh-debug/types
 */

import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/**
 * One instrumentation log entry POSTed to the debug-log endpoint. `data` is
 * the free-form diagnostic payload and is absent when the entry carried none.
 */
export interface DebugLogEntry {
  /** The step name the entry was captured at. */
  step: string
  /** ISO-8601 timestamp of the entry, as reported by the instrumentation. */
  at: string
  /** Free-form diagnostic payload; absent when the entry carried none. */
  data?: JsonValue
}

/**
 * The debug projection's wire value. `active` is the logged state in force
 * (the last `debug/mode`, inactive before the first); `pending` is true while
 * a logged `/debug` selection targets a state other than `active`, has not
 * failed through its paired `command/done`, and no later `debug/mode` event has
 * recorded that state. `logs` is the current cycle's captured entries (since
 * the last `finish_debug` verdict or mode entry), the newest kept within the
 * host's sliding window. Capability absence (debug-mode not composed) is the
 * key's absence, never a value.
 */
export interface DebugProjection {
  active: boolean
  pending: boolean
  logs: DebugLogEntry[]
}

/** Host state used to derive {@link DebugProjection}. */
export interface DebugUnitState {
  /** Logged debug mode. */
  active: boolean
  /** The selection's target mode; null when no selection is outstanding. */
  wanted: boolean | null
  /** The latest debug command awaiting its paired settlement. */
  running: { commandId: CommandId; wanted: boolean } | null
  /** Active state recorded by the latest `request/header`, or null. */
  activeAtLastHeader: boolean | null
  /** The current cycle's captured log entries (the fold's sliding window). */
  logs: DebugLogEntry[]
  /** `finish_debug` call ids whose `tool/result` has not yet settled. */
  finishDebugCallIds: string[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Host debug-mode fold state. */
    debug: DebugUnitState
  }
  interface SessionProjectionMap {
    /** Debug collaboration state folded from the debug command lifecycle, `debug/mode`, and `debug/log` events. */
    debug: DebugProjection
  }
}
