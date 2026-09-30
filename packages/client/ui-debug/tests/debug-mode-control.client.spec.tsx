// @vitest-environment jsdom
/**
 * DebugChip over the `debug` projection: nothing renders while the capability
 * is absent or the effective target is the default mode; while debug mode is
 * the target, the chip executes /debug off and remains visible through failures
 * until the projection confirms the exit.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { DebugProjection } from '@deepseek-ai/dsh-debug/client'
import { DebugChip, type DebugChipProps } from '../src/client/DebugModeControl.tsx'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

// The framework-injected t seat, stubbed over the zh dictionaries (the default locale).
const t: DebugChipProps['t'] = makeTranslate(zh, commonZh)

// The chip renders from active and pending only; the fixture carries an empty log window.
function proj(active: boolean, pending: boolean): DebugProjection {
  return { active, pending, logs: [] }
}

function setup(
  debug: DebugProjection | undefined,
  exitDebugMode = vi.fn(() => Promise.resolve<string | null>(null)),
  locked = false,
) {
  const store = createSnapshotStore<{ value: DebugProjection | undefined }>({ value: debug })
  // The chip renders only from the debug projection and its own four seats. The
  // key-addressed projection reader is the real contract (the store carries the
  // projection under `value`); the session standard kit is present but unused,
  // so each of those seats is an inert `() => undefined` stub.
  const useProjection = (key: string) => key === 'debug' ? store.getSnapshot().value : undefined
  const props = {
    useProjection,
    locked,
    exitDebugMode,
    t,
    useSession: () => undefined,
    sessionId: undefined,
    useSessions: () => undefined,
    useSessionStatus: () => undefined,
    useSessionRetainInfo: () => undefined,
  } as DebugChipProps
  const view = render(<DebugChip {...props} />)
  return { store, exitDebugMode, view }
}

const chip = () => screen.getByRole('button', { name: '调试模式已开启，按下关闭' })

describe('DebugChip', () => {
  it('renders nothing for an absent capability or a default-mode target', () => {
    const absent = setup(undefined)
    expect(absent.view.container.innerHTML).toBe('')
    cleanup()
    const inactive = setup(proj(false, false))
    expect(inactive.view.container.innerHTML).toBe('')
    cleanup()
    const leaving = setup(proj(true, true))
    expect(leaving.view.container.innerHTML).toBe('')
  })

  it('renders the Debug status for active and pending-entry targets', () => {
    setup(proj(true, false))
    expect(chip().textContent).toBe('Debug')
    cleanup()
    setup(proj(false, true))
    expect(chip().textContent).toBe('Debug')
  })

  it('executes /debug off once and follows the projection down', async () => {
    let resolve!: (value: string | null) => void
    const exitDebugMode = vi.fn(() => new Promise<string | null>((done) => { resolve = done }))
    const { store } = setup(proj(true, false), exitDebugMode)
    fireEvent.click(chip())
    expect(exitDebugMode).toHaveBeenCalledTimes(1)
    fireEvent.click(chip())
    expect(exitDebugMode).toHaveBeenCalledTimes(1)
    resolve(null)
    store.set({ value: proj(true, true) })
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '调试模式已开启，按下关闭' })).toBeNull()
    })
  })

  it('disables under the locked owner prop', () => {
    setup(proj(true, false), vi.fn(), true)
    expect((chip() as HTMLButtonElement).disabled).toBe(true)
  })

  it('surfaces admission and transport failures while staying visible', async () => {
    const exitDebugMode = vi.fn()
      .mockResolvedValueOnce('host said no')
      .mockRejectedValueOnce(new Error('network down'))
      .mockRejectedValueOnce('socket closed')
    setup(proj(true, false), exitDebugMode)
    fireEvent.click(chip())
    expect((await screen.findByText('退出调试模式失败')).getAttribute('title')).toBe('host said no')
    expect(chip()).toBeTruthy()

    fireEvent.click(chip())
    expect(await screen.findByTitle('network down')).toBeTruthy()

    fireEvent.click(chip())
    expect(await screen.findByTitle('socket closed')).toBeTruthy()
  })

  it('ignores in-flight fulfillment and rejection after unmount', () => {
    let resolve!: (value: string | null) => void
    const successful = setup(
      proj(true, false),
      vi.fn(() => new Promise<string | null>((done) => { resolve = done })),
    )
    fireEvent.click(chip())
    successful.view.unmount()
    expect(() => { resolve(null) }).not.toThrow()

    let reject!: (reason: unknown) => void
    const exitDebugMode = vi.fn(() => new Promise<string | null>((_done, fail) => { reject = fail }))
    const { view } = setup(proj(true, false), exitDebugMode)
    fireEvent.click(chip())
    view.unmount()
    expect(() => { reject(new Error('late')) }).not.toThrow()
  })
})
