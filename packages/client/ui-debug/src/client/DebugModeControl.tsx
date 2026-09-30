import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconCloseFillRegular } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pulls the ui-conversation SlotMap merge (the input.debug seat and
// its {locked} owner share).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { DebugChipInjected } from './index.ts'
import css from './DebugModeControl.module.css'

/** Full debug-seat component props: runtime share (standard kit + locked owner prop) & injected share & the locale seat. */
export type DebugChipProps =
  PropsRuntime<'conversation.input.debug'> & InjectFace<DebugChipInjected> & PropsLocale<'debug'>

/**
 * Debug-mode status over the host-computed `debug` projection. The chip
 * renders only while the effective target is debug mode (`pending ? !active
 * : active` — a folded host value, not client optimism) and executes /debug off.
 */
export function DebugChip({ useProjection, locked, exitDebugMode, t }: DebugChipProps) {
  /* jscpd:ignore-start -- debug chip mirrors plan-mode chip: same projection gate and exit-button behavior */
  const debug = useProjection('debug')
  const [leaving, setLeaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  if (debug === undefined) return null
  const target = debug.pending ? !debug.active : debug.active
  if (!target) return null

  const off = (): void => {
    // No leaving/locked guard: both disable the button, so no click arrives.
    setLeaving(true)
    setError(null)
    void exitDebugMode().then((failure) => {
      if (!aliveRef.current) return
      setLeaving(false)
      setError(failure)
    }, (reason: unknown) => {
      if (!aliveRef.current) return
      setLeaving(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  return (
    <span className={css.wrap}>
      <button
        type="button"
        className={css.chip}
        aria-label={t('chip.on.aria')}
        title={t('chip.on.title')}
        disabled={locked || leaving}
        onClick={off}
      >
        {t('chip.label')}
        <span className={css.close} aria-hidden>
          <IconCloseFillRegular size={12} />
        </span>
      </button>
      {error !== null && <span className={css.error} role="status" title={error}>{t('chip.exitFailed')}</span>}
    </span>
  )
}
/* jscpd:ignore-end */
