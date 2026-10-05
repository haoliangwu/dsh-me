// BtwCommandCard: the /btw command row — command name plus the child agent's
// answer rendered as full markdown (the default command row collapses long
// text to a single truncated line). Registered as the keyed commandview
// entry for the `btw` command name; every other command keeps the generic row.

import { useMemo, type ReactNode } from 'react'
import { IconApiOutline14, MarkdownText, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CommandRowOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './BtwCommandCard.module.css'

// The published dsh-client-ui-primitives bundle (0.2.0-rc.2) ships
// `IconApiOutline14` at runtime but the shipped d.ts omits it (type/runtime
// drift — the typings carry the base `IconApiOutline` the runtime lacks).
// Declare the real runtime export so the row can keep using it.
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  export function IconApiOutline14(props: { readonly size?: number }): JSX.Element
}

type BtwCommandCardProps = CommandRowOwnerProps & PropsLocale<'btw'>

type RowState = 'running' | 'ok' | 'error'

/** Node state → row state semantic (running while unsettled; outcome kind after). */
function stateOf(outcome: CommandRowOwnerProps['node']['outcome']): RowState {
  if (outcome === null) return 'running'
  return outcome.kind === 'error' ? 'error' : 'ok'
}

function leadingFor(state: RowState): ReactNode {
  // The published dsh-client-ui-primitives bundle (0.2.0-rc.2) ships the
  // 14px icon variant, not the base IconApiOutline.
  return state === 'error' ? <StateDot state="error" /> : <IconApiOutline14 size={14} />
}

/** The one-line summary: the running label while unsettled, an outcome label
 * only when the outcome carries no text (the body renders real text), else
 * null so the row renders no summary. */
function summaryOf(t: PropsLocale<'btw'>['t'], state: RowState, text: string | undefined): string | null {
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
