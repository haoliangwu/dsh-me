/**
 * dsh-ui-shortcuts canonical action order: the single source for the config
 * fetch loop (client/index.ts) and the help-overlay row order
 * (ShortcutsHelp.tsx). One definition, two consumers — the displayed order
 * can never drift from the fetch order.
 */
import type { ActionId } from '../pure.ts'

/** One help-overlay row: the action and its dictionary label key. */
export interface ShortcutRow {
  readonly labelKey: 'actionSidebar' | 'actionRightbar' | 'actionFocus' | 'actionHelp'
  readonly bindingKey: ActionId
}

/** The four actions + labels in canonical display order. */
export const SHORTCUT_ROWS: readonly ShortcutRow[] = [
  { labelKey: 'actionSidebar', bindingKey: 'sidebar' },
  { labelKey: 'actionRightbar', bindingKey: 'rightbar' },
  { labelKey: 'actionFocus', bindingKey: 'focus' },
  { labelKey: 'actionHelp', bindingKey: 'help' },
]

/** The canonical action ids in the same order (config fetch loop). */
export const ACTIONS: readonly ActionId[] = SHORTCUT_ROWS.map(row => row.bindingKey)