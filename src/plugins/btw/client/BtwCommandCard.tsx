// BtwCommandCard: the /btw command row — command name plus the child agent's
// answer rendered as full markdown (the default command row collapses long
// text to a single truncated line). Registered as the keyed commandview
// entry for the `btw` command name; every other command keeps the generic row.

import { useMemo, type ReactNode } from 'react'
import { IconApiOutline14, MarkdownText, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CommandRowOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './BtwCommandCard.module.css'

type BtwCommandCardProps = CommandRowOwnerProps & PropsLocale<'btw'>

type RowState = 'running' | 'ok' | 'error'

/** Node state → row state semantic (running while unsettled; outcome kind after). */
function stateOf(outcome: CommandRowOwnerProps['node']['outcome']): RowState {
  if (outcome === null) return 'running'
  return outcome.kind === 'error' ? 'error' : 'ok'
}

function leadingFor(state: RowState): ReactNode {
  return state === 'error' ? <StateDot state="error" /> : <IconApiOutline14 size={14} />
}

/** The one-line summary: the running label while unsettled, an outcome label
 * only when the outcome carries no text (the body renders real text), else
 * null so the row renders no summary. */
function summaryOf(t: (key: string) => string, state: RowState, text: string | undefined): string | null {
  if (state === 'running') return t('running')
  if (text === undefined) return state === 'error' ? t('failed') : t('done')
  return null
}

export function BtwCommandCard({ node, t }: BtwCommandCardProps) {
  const state = stateOf(node.outcome)
  const text = node.outcome?.text
  const labels = useMemo(() => ({
    code: { copyLabel: t('copy'), copiedLabel: t('copied') },
    footnotes: t('footnotes'),
  }), [t])
  const summary = summaryOf(t, state, text)
  return (
    <div className={css.root} data-state={state}>
      <div className={css.row}>
        <span className={css.leading}>{leadingFor(state)}</span>
        <span className={css.title}>{node.name ?? t('title')}</span>
        <span className={css.separator} aria-hidden />
        {summary !== null && <span className={css.summary} data-error={state === 'error' || undefined}>{summary}</span>}
      </div>
      {text !== undefined && (
        <div className={css.body}>
          <MarkdownText text={text} labels={labels} />
        </div>
      )}
    </div>
  )
}
