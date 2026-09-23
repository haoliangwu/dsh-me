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
 *
 * Each row lays out as label-left / keycap-group-right on a shared edge.
 * The display binding string is split into one chip per key: on mac the
 * string concatenates glyphs with no separator, so it splits by code point
 * ("⌘B" -> "⌘" + "B"); elsewhere the string joins keys with '+', so it
 * splits on '+' ("Ctrl+B" -> "Ctrl" + "B"). The keys group keeps an
 * aria-label of the joined binding so the accessible name is unchanged.
 */
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ActionId } from '../pure.ts'
import { SHORTCUT_ROWS } from './rows.ts'
import styles from './ShortcutsHelp.module.css'

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

/**
 * Split a display binding string into keycap pieces. Heuristic: a string
 * containing '+' came from a non-mac platform and splits on '+' (trimmed);
 * otherwise it is a mac concatenation of single glyphs and splits by code
 * point (Array.from, so surrogate pairs never split).
 */
export function splitBinding(binding: string): string[] {
  const pieces = binding.includes('+') ? binding.split('+') : Array.from(binding)
  return pieces.map(piece => piece.trim()).filter(piece => piece.length > 0)
}

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
        <ul className={styles.list}>
          {rows.map(row => (
            <li key={row.label} className={styles.row}>
              <span className={styles.label}>{row.label}</span>
              <span className={styles.keys} aria-label={row.binding}>
                {splitBinding(row.binding).map((piece, index) => (
                  <kbd key={`${piece}-${index}`} className={styles.keycap}>
                    {piece}
                  </kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}