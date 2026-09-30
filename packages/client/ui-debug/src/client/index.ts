/**
 * Debug control plugin, browser half: occupies the composer's named
 * `conversation.input.debug` seat with an active-state status chip. Debug mode
 * is entered through the command source; while the projection's effective
 * target is debug mode the chip renders and executes /debug off through
 * `command.execute`, otherwise the seat stays empty. Reads ride the generic
 * projection pair through the standard-kit `useProjection`; zero client-side
 * debug state.
 */
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the ui-conversation SlotMap merge (the input.debug seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the `debug` SessionProjectionMap merge for useProjection.
import type {} from '@deepseek-ai/dsh-debug/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { DebugChip } from './DebugModeControl.tsx'
import { en, zh, type DebugKey } from './locales.ts'

export type { DebugKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The composer debug chip's copy. */
    debug: DebugKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'debug'

/** Injected business face of the composer debug seat. */
export interface DebugChipInjected {
  /**
   * Leave debug mode by executing /debug off.
   * @returns null on admitted execution; a user-visible failure line otherwise.
   */
  exitDebugMode: () => Promise<string | null>
}

/** Required services: the seat's slot registry, commands Remote, and locale registry. */
export const inject = ['slots', 'remote', 'remote.commands', 'locale']

/**
 * Client plugin body: register the debug chip over the command channel.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-debug: dictionaries')

  ctx.slots.inject('conversation.input.debug', () => ctx.slots.register({
    name: 'conversation.input.debug',
    locale: NS,
    inject: (sessionId: SessionId): DebugChipInjected => ({
      // Failure strings stay English (error-surface policy: not localized).
      exitDebugMode: async () => {
        const result = await ctx.remote.commands.execute(sessionId, '/debug off', [])
        if (!result.ok) return `${result.error.message} (${result.error.code})`
        if (result.value === undefined) return 'unknown command: /debug off'
        return null
      },
    }),
  }, DebugChip))
}
