/**
 * ShortcutsHelp: the help overlay entry registered into the shell.overlay LIST
 * slot. Renders one row per action with its CURRENT binding (read through the
 * selector hooks bound from the inject hooks compartment — the apply body
 * publishes the host config, so a profile rebind shows here immediately, no
 * hardcoded defaults) plus a hint pointing at the config field. Open state
 * rides the same engine-side store the shortcut toggles, so the binding key
 * and the Modal agree without lifting state. Escape closes it through the
 * framework Modal onClose AND the engine-level Escape handling in the apply
 * body (which wins in capture phase); the component itself only renders the
 * Modal.
 */
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ActionId } from '../pure.ts'
import { SHORTCUT_ROWS } from './rows.ts'

/** The slot-inject compartment the apply body provides through register(). */
export interface ShortcutsHelpInjected {
  hooks: {
    /** Current display-ready binding strings per action (empty until config arrives). */
    bindings: HostObservable<Readonly<Partial<Record<ActionId, string>>>>
    /** Whether the overlay is open. */
    open: HostObservable<boolean>
  }
  /** Close the overlay (Modal onClose and engine Escape both land here). */
  close: () => void
}

/** Composed component props: the shell.overlay runtime share + locale + the bound hooks face. */
export type ShortcutsHelpProps = PropsRuntime<'shell.overlay'> & PropsLocale<'shortcuts'> & InjectFace<ShortcutsHelpInjected>

export function ShortcutsHelp(props: ShortcutsHelpProps) {
  const { t, close, useBindings, useOpen } = props
  // The slots runtime binds the inject hooks into typed selector hooks.
  const open = useOpen(open => open)
  const bindings = useBindings(bindings => bindings)
  const rows = SHORTCUT_ROWS
    .map(row => ({ label: t(row.labelKey), binding: bindings[row.bindingKey] }))
    .filter(row => row.binding !== undefined && row.binding !== '')
  return (
    <Modal open={open} onClose={close} title={t('title')} closeLabel={t('close')} description={t('rebindHint')}>
      {rows.length > 0 && (
        <ul>
          {rows.map(row => (
            <li key={row.label}>
              <span>{row.label}</span>
              <kbd>{row.binding}</kbd>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}