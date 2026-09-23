/**
 * dsh-undo assistant-actions entry: the one undo icon button beside copy and
 * the feedback pair. Visible only while the finalized assistant message is
 * the session's last closed turn, is not already undone, and the agent is
 * idle (design §4.1). Click rides the injected undo verb (RPC + composer
 * refill). Button chrome mirrors the host's MessageIconActions/f eedback
 * `.action` icon-button so slot-injected controls match their siblings.
 */
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { UndoArrow } from './icons.tsx'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { UndoKey } from './locales.ts'
import type { UndoState } from './undo-state.ts'
import css from './undo.module.css'

/** The undo button's business face (inject share + the bound state hook). */
export interface UndoButtonProps {
  /** The finalized assistant message this actions row belongs to. */
  readonly messageId: string
  /** The undo namespace translate seat. */
  readonly t: (key: UndoKey, params?: Record<string, unknown>) => string
  /** Bound selector hook over the session's derived undo state. */
  readonly useUndo: SnapshotSelectorHook<UndoState>
  /** Tombstone the message's turn; resolves after the RPC + refill. */
  readonly undo: (messageId: string) => Promise<boolean>
}

/**
 * Render the undo action, or nothing when the target turn is not eligible
 * (design §4.1): last closed turn, not already undone, agent idle.
 * @param props - message identity, translate seat, state hook, and undo verb.
 * @returns the icon button, or null.
 */
export function UndoButton({ messageId, t, useUndo, undo }: UndoButtonProps): React.ReactNode {
  const state = useUndo(value => value)
  const turn = state.messageTurn.get(messageId)
  if (turn === undefined) return null
  if (state.undoneTurns.has(turn)) return null
  if (state.lastTurn !== turn) return null
  if (!state.idle) return null
  return (
    <Tooltip label={t('buttonAria')} side="bottom">
      <button
        type="button"
        className={css.action}
        aria-label={t('buttonAria')}
        onClick={() => { void undo(messageId) }}
      >
        <UndoArrow />
      </button>
    </Tooltip>
  )
}