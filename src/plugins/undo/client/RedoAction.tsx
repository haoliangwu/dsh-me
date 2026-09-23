/**
 * dsh-undo assistant-actions entry: the one redo icon button beside copy and
 * the feedback pair, shown only while the owner turn is currently shadowed by
 * a dsh-undo tombstone that was not redone (design §4.1/§4.3). Registered as
 * its own list entry (`id: 'undo-redo'`, order right after the undo entry) in
 * the SAME `conversation.chat.assistant-actions` list slot the undo button
 * rides — the actions strip lives in the turn-tail row (`data-turn-tail`),
 * which the row hider never hides (`9:turn-tail` prefix excluded), so the
 * redo entry fills exactly the spot the undo button vacates once the turn is
 * undone. Click rides the injected redo verb; the host re-validates the
 * tombstone is still the surface tail.
 */
import { IconRefreshOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { UndoKey } from './locales.ts'
import type { UndoState } from './undo-state.ts'
import css from './undo.module.css'

/** The redo action's composed props: message identity, state hook, translate seat, and the redo verb. */
export interface RedoActionProps {
  /** The finalized assistant message this actions row belongs to. */
  readonly messageId: string
  /** The undo namespace translate seat. */
  readonly t: (key: UndoKey, params?: Record<string, unknown>) => string
  /** Bound selector hook over the session's derived undo state. */
  readonly useUndo: SnapshotSelectorHook<UndoState>
  /** Replay the last undone turn; resolves after the host RPC. */
  readonly redo: () => Promise<boolean>
}

/**
 * Render the redo action, or nothing when the owner turn is not currently
 * shadowed (design §4.1): undone turns show it, every other turn renders
 * null. Click redos the last undone turn (the host re-validates the
 * tombstone is still the surface tail).
 * @param props - message identity, state hook, translate seat, and redo verb.
 * @returns the icon button, or null.
 */
export function RedoAction({ messageId, t, useUndo, redo }: RedoActionProps): React.ReactNode {
  const state = useUndo(value => value)
  const turn = state.messageTurn.get(messageId)
  if (turn === undefined) return null
  if (!state.undoneTurns.has(turn)) return null
  return (
    <Tooltip label={t('redoAria')} side="bottom">
      <button
        type="button"
        className={css.action}
        aria-label={t('redoAria')}
        onClick={() => { void redo() }}
      >
        <IconRefreshOutline16 />
      </button>
    </Tooltip>
  )
}