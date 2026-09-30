import { useMemo, useState } from 'react'
import {
  Button, IconEditOutlineRegular, MarkdownText, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PendingQuestion, DebugReview, QuestionComposerProps } from './contract/slots.ts'
import css from './DebugReviewPanel.module.css'

/** The panel's own props: the question domain face, the narrowed review, and the locale seat. */
export type DebugReviewPanelProps =
  { pending: PendingQuestion; review: DebugReview } & Pick<QuestionComposerProps, 't'>

/**
 * Optional-prop spread for a decision button's tooltip: `title` is optional on
 * the DOM props, and exactOptionalPropertyTypes rejects an explicit undefined.
 *
 * @param description - the asker's option description, when it carries one.
 * @returns The `title` prop to spread, or nothing.
 */
function tooltip(description: string | undefined): { title?: string } {
  return description === undefined ? {} : { title: description }
}

/**
 * Render a debug review as a decision card over the steps to reproduce the
 * issue.
 *
 * @param props - the question domain face, the narrowed debug review, and `t`.
 * @returns The debug-review takeover for this request.
 */
export function DebugReviewPanel({ pending, review, t }: DebugReviewPanelProps) {
  // Foreground decisions wait for the resolved frame; accepted Remote decisions
  // hide the panel. A failed send re-enables the buttons and shows the error.
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const settle = (send: () => Promise<void>, remote = false): void => {
    setBusy(true)
    setError(null)
    void send()
      .then(() => {
        if (!remote) return
        setBusy(false)
        void pending.dismiss().catch(() => { setError(t('status.sent')) })
      })
      .catch((cause: unknown) => {
        setBusy(false)
        setError(cause instanceof Error ? cause.message : String(cause))
      })
  }
  const decide = (label: string): void => {
    settle(() => pending.answer({ answers: [{ id: review.id, selected: [label] }] }), pending.snapshot().channel === 'rpc')
  }
  const markdownLabels = useMemo(() => ({
    code: { copyLabel: t('copy'), copiedLabel: t('copied') },
    footnotes: t('markdown.footnotes'),
  }), [t])
  const markFixed = review.markFixed

  return (
    <div className={css.frame} data-debug-review-key={pending.key}>
      <section className={css.card} aria-label={review.question} aria-busy={busy}>
        <div className={css.strip}>
          <StateDot state={busy ? 'ongoing' : 'warning'} />
          {t('debug.header')}
        </div>
        <div className={css.body} data-debug-review-scroll>
          <MarkdownText text={review.instructions} labels={markdownLabels} />
        </div>
        <div className={css.footer}>
          <div className={css.feedback} role="status">{error}</div>
          <div className={css.actions}>
            <Button
              variant="outline" className={css.dismiss} icon={<IconEditOutlineRegular size={14} />}
              disabled={busy} onClick={() => { settle(() => pending.dismiss()) }}
            >
              {t('debug.dismiss')}
            </Button>
            {markFixed !== undefined && (
              <Button
                variant="outline" {...tooltip(markFixed.description)}
                disabled={busy} onClick={() => { decide(markFixed.label) }}
              >
                {t('debug.markFixed')}
              </Button>
            )}
            <Button
              variant="primary" {...tooltip(review.proceed.description)}
              disabled={busy} onClick={() => { decide(review.proceed.label) }}
            >
              {t('debug.proceed')}
            </Button>
          </div>
        </div>
      </section>
    </div>
  )
}
