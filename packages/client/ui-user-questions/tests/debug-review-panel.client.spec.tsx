// @vitest-environment jsdom
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  createWaterfallRequest, PendingQuestion, debugReviewOf, type QuestionComposerProps, type QuestionWait,
} from '../src/client/contract/slots.ts'
import { createQuestionDraftStore } from '../src/client/draft-store.ts'
import { QuestionComposer } from '../src/client/QuestionComposer.tsx'
import { en, zh } from '../src/client/locales.ts'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'

// Every session-scope fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })

afterEach(cleanup)


const SID = 's1' as SessionId

const seatOver = (dict: Record<string, string>, common: Record<string, string>): QuestionComposerProps['t'] =>
  (key => dict[key] ?? common[key] ?? key)

type SessionState = Parameters<Parameters<QuestionComposerProps['useSession']>[0]>[0]
type ConversationState = Parameters<Parameters<QuestionComposerProps['useConversation']>[0]>[0]
type ChatState = Parameters<Parameters<QuestionComposerProps['useChat']>[0]>[0]
type TrajectoryState = Parameters<Parameters<QuestionComposerProps['useTrajectory']>[0]>[0]
type InputState = Parameters<Parameters<QuestionComposerProps['useInput']>[0]>[0]
type AttentionState = Parameters<Parameters<QuestionComposerProps['useSessionStatus']>[0]>[0]

const sessionState: SessionState = {
  sessionId: SID,
  pendingSubmissions: [],
  running: false,
  subagent: null,
  removed: false,
  openState: 'open',
  openError: null,
  hasMore: false,
  loadingOlder: false,
  promptError: null,
  blank: false,
  lastAgentError: null,
  promptAttempted: false,
  awaitingFirstTurn: false,
}
const sessionList = {
  ids: [SID],
  byId: { [SID]: { id: SID, displayTitle: 'Session', running: false, retainedBy: {}, blank: false, updatedAt: 0 } },
  phase: 'ready' as const,
  projectionsBySession: {},
}
const attentionState: AttentionState = new Map()
const workspaceState = {
  items: [],
  archivedSessionIds: [],
  pinnedSessionIds: [],
  state: 'idle' as const,
  phase: 'ready' as const,
  error: null,
}
const conversationState: ConversationState = {
  views: { get: () => undefined, grouped: () => undefined },
  activeTargets: new Set(),
}
const emptyKeys: readonly string[] = []
const emptyNodeSource = { getSnapshot: () => undefined, subscribe: () => () => {} }
const chatState: ChatState = {
  order: emptyKeys,
  nodes: {
    get: () => undefined,
    source: () => emptyNodeSource,
    turnDataSource: () => { throw new Error('unused') },
    processSource: () => emptyNodeSource,
    values: () => [],
  },
  locations: { getTurn: () => emptyKeys, getStep: () => emptyKeys },
  navigation: { items: () => [] },
  timeline: { turnOrder: [], turns: new Map() },
  legacy: {
    nodes: [],
    turnTimings: new Map(),
    turnEnds: new Map(),
    partial: null,
    runningCalls: [],
  },
}
const trajectoryState: TrajectoryState = {
  eventNodes: [],
  eventLocations: new Map(),
  requests: [],
  callSchemas: new Map(),
  partial: null,
  runningCalls: [],
}
const inputState: InputState = {
  draft: '',
  attachmentIds: [],
  draftRev: 0,
  phase: 'plain',
  occurrences: [],
  queue: [],
}

const questionDraftStore = createQuestionDraftStore().create(SID)

/** Framework standard-kit stubs: the panel consumes only the locale seat. */
const kit: Omit<QuestionComposerProps, 'matched'> = {
  useQuestionCard: () => { throw new Error('debug review does not read question card state') },
  renderSlot: () => null,
  SessionProvider: ({ children }) => children,
  sessionId: SID,
  session: undefined,
  pendingInteraction: undefined,
  useSession: selector => selector(sessionState),
  useSessions: selector => selector(sessionList),
  usePanelInfo, useResource,
  useSessionStatus: selector => selector(attentionState),
  useSessionRetainInfo: () => undefined,
  useWorkspaces: selector => selector(workspaceState),
  useConversation: selector => selector(conversationState),
  useChat: selector => selector(chatState),
  useTrajectory: selector => selector(trajectoryState),
  useProjection: (() => undefined),
  useInput: selector => selector(inputState),
  inputActions: {
    captureInsertion: () => ({ start: 0, end: 0, draftRev: 0 }),
    insertText: () => false,
    setDraft: () => { throw new Error('unused') },
    addAttachments: () => { throw new Error('unused') },
    removeAttachment: () => { throw new Error('unused') },
    pruneAttachments: () => { throw new Error('unused') },
    submit: () => { throw new Error('unused') },
  },
  useStore: selector => selector(questionDraftStore.getSnapshot()),
  actions: questionDraftStore.actions,
  t: seatOver(zh, commonZh),
}

const INSTRUCTIONS = '# Reproduce the crash\n\n- run the app with the profile\n- open the settings page and save\n'

/** The debug-mode request shape: one question, the instructions as detail, proceed named. */
const questions = (): QuestionWait['questions'] => [{
  id: 'debug-review',
  header: 'Debug',
  question: 'How did the issue behave when you ran the steps above?',
  detail: INSTRUCTIONS,
  options: [
    { label: 'Proceed', description: 'The issue is reproduced; continue with the logs in debug.txt.' },
    { label: 'Mark as fixed', description: 'The issue is fixed; remove the debug instrumentation.' },
  ],
  intent: { kind: 'debug-review', approve: 'Proceed' },
}]

/** Pending waterfall fixture with observable Client response methods. */
function wait(items: QuestionWait['questions'] = questions()) {
  const carrier = new PendingQuestion(SID, items)
  const request = createWaterfallRequest(undefined, undefined, (channel) => { carrier.detachWaterfall(channel) })
  carrier.attachWaterfall(request.channel)
  const answer = vi.spyOn(carrier, 'answer')
  const cancel = vi.spyOn(carrier, 'dismiss')
  void request.result.catch(() => {})
  return { carrier, answer, cancel }
}

const decision = (label: string) => ({ answers: [{ id: 'debug-review', selected: [label] }] })

describe('debugReviewOf', () => {
  it('narrows a debug-review request to its decision, options included', () => {
    expect(debugReviewOf(questions())).toEqual({
      id: 'debug-review',
      question: 'How did the issue behave when you ran the steps above?',
      instructions: INSTRUCTIONS,
      proceed: { label: 'Proceed', description: 'The issue is reproduced; continue with the logs in debug.txt.' },
      markFixed: { label: 'Mark as fixed', description: 'The issue is fixed; remove the debug instrumentation.' },
    })
  })

  it('leaves markFixed absent when the asker offered proceed alone', () => {
    const [question] = questions()
    const review = debugReviewOf([{ ...question as object, options: [{ label: 'Proceed' }] } as never])
    expect(review?.proceed).toEqual({ label: 'Proceed' })
    expect(review === undefined ? true : 'markFixed' in review).toBe(false)
  })

  it.each([
    ['a batch of more than one question', () => [...questions(), ...questions()]],
    ['no intent at all', () => [{ ...questions()[0] as object, intent: undefined }]],
    ['an intent without the instructions as detail', () => [{ ...questions()[0] as object, detail: undefined }]],
    ['an intent whose approve names no option', () => [{
      ...questions()[0] as object, intent: { kind: 'debug-review', approve: 'Ship it' },
    }]],
    ['an intent with no options at all', () => [{ ...questions()[0] as object, options: undefined }]],
    // Two buttons cannot send a third label or a combination, and the generic
    // flow can: an intent never costs the user a reachable answer.
    ['a third option the card could not offer', () => [{
      ...questions()[0] as object,
      options: [{ label: 'Proceed' }, { label: 'Mark as fixed' }, { label: 'Start over' }],
    }]],
    ['a multi-select decision', () => [{ ...questions()[0] as object, multiSelect: true }]],
  ])('declines %s, leaving the request to the generic flow', (_case, build) => {
    expect(debugReviewOf(build() as never)).toBeUndefined()
  })

  it('declines an empty batch, which the generic flow reports as such', () => {
    expect(debugReviewOf([])).toBeUndefined()
  })

  it('is not claimed by a plan-review request of the same shape', () => {
    const [question] = questions()
    const plan = debugReviewOf([{ ...question as object, intent: { kind: 'plan-review', approve: 'Proceed' } } as never])
    expect(plan).toBeUndefined()
  })
})

describe('DebugReviewPanel', () => {
  it('renders the instructions under a review strip, with none of the quiz affordances', () => {
    const { carrier } = wait()
    render(<QuestionComposer matched={carrier} {...kit} />)

    expect(document.querySelector('[data-debug-review-key]')?.getAttribute('data-debug-review-key')).toBe(carrier.key)
    expect(screen.getByText(zh['debug.header'])).toBeTruthy()
    // The instructions render as markdown, so their heading is a heading.
    expect(screen.getByRole('heading', { name: 'Reproduce the crash' })).toBeTruthy()
    expect(screen.getByText('open the settings page and save')).toBeTruthy()
    // The question text stays as the card's accessible name rather than a title
    // that reads like a test item.
    expect(screen.getByLabelText('How did the issue behave when you ran the steps above?')).toBeTruthy()
    // No pager, no numbered options, no skip, no custom answer.
    expect(screen.queryByText('1 / 1')).toBeNull()
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.queryByText(zh['action.skip'])).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('answers with the asker\'s proceed label and keeps its description as the tooltip', () => {
    const { carrier, answer } = wait()
    render(<QuestionComposer matched={carrier} {...kit} />)

    const proceed = screen.getByRole('button', { name: zh['debug.proceed'] })
    expect(proceed.getAttribute('title')).toBe('The issue is reproduced; continue with the logs in debug.txt.')
    fireEvent.click(proceed)
    expect(answer).toHaveBeenCalledWith(decision('Proceed'))
    // One-shot: every action locks until the host's resolved frame lands.
    expect(proceed.hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: zh['debug.markFixed'] }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(proceed)
    expect(answer).toHaveBeenCalledTimes(1)
  })

  it('answers with the asker\'s mark-fixed label', () => {
    const { carrier, answer } = wait()
    render(<QuestionComposer matched={carrier} {...kit} />)

    fireEvent.click(screen.getByRole('button', { name: zh['debug.markFixed'] }))
    expect(answer).toHaveBeenCalledWith(decision('Mark as fixed'))
  })

  it('dismisses the request so the composer returns for a plain message', () => {
    const { carrier, cancel } = wait()
    render(<QuestionComposer matched={carrier} {...kit} />)

    fireEvent.click(screen.getByRole('button', { name: zh['debug.dismiss'] }))
    expect(cancel).toHaveBeenCalledWith()
  })

  it('omits the tooltip for an option carrying no description', () => {
    const { carrier } = wait([{
      ...questions()[0] as object,
      options: [{ label: 'Proceed' }, { label: 'Mark as fixed' }],
    }] as never)
    render(<QuestionComposer matched={carrier} {...kit} />)

    expect(screen.getByRole('button', { name: zh['debug.proceed'] }).hasAttribute('title')).toBe(false)
    expect(screen.getByRole('button', { name: zh['debug.markFixed'] }).hasAttribute('title')).toBe(false)
  })

  it('hides the mark-fixed action when the asker offered proceed alone', () => {
    const { carrier } = wait([{
      ...questions()[0] as object, options: [{ label: 'Proceed' }],
    }] as never)
    render(<QuestionComposer matched={carrier} {...kit} />)

    expect(screen.queryByRole('button', { name: zh['debug.markFixed'] })).toBeNull()
    expect(screen.getByRole('button', { name: zh['debug.proceed'] })).toBeTruthy()
  })

  it('re-arms the actions and says why when the decision does not land', async () => {
    const { carrier, answer } = wait()
    answer.mockRejectedValue(new Error('question response rejected: not-pending'))
    render(<QuestionComposer matched={carrier} {...kit} />)

    fireEvent.click(screen.getByRole('button', { name: zh['debug.proceed'] }))
    const failure = await screen.findByText('question response rejected: not-pending')
    expect(failure.getAttribute('role')).toBe('status')
    // Re-armed for the retry: a lost click must not leave a dead card.
    expect(screen.getByRole('button', { name: zh['debug.proceed'] }).hasAttribute('disabled')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: zh['debug.proceed'] }))
    expect(answer).toHaveBeenCalledTimes(2)
  })

  it('reports a non-Error transport failure as its stringified value', async () => {
    // A non-Error rejection is the case under test: a carrier can reject with
    // anything, and the panel must still show the user something.
    const { carrier, cancel } = wait()
    cancel.mockRejectedValue('socket gone')
    render(<QuestionComposer matched={carrier} {...kit} />)

    fireEvent.click(screen.getByRole('button', { name: zh['debug.dismiss'] }))
    expect(await screen.findByText('socket gone')).toBeTruthy()
  })

  it('carries the same decision surface in English', () => {
    const { carrier } = wait()
    render(<QuestionComposer matched={carrier} {...kit} t={seatOver(en, commonEn)} />)

    expect(screen.getByText('Debug review')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Proceed' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Mark as fixed' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Chat about it' })).toBeTruthy()
  })
})
