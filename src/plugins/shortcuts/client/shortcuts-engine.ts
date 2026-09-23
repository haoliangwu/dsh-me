/**
 * dsh-ui-shortcuts engine: the document keydown dispatcher plus the guard
 * stack (spec guard domain). Pure DOM, no React, no service knowledge — it
 * holds the parsed bindings and forwards a matched keydown to the owner's
 * action callback, so the apply body stays a thin wiring layer and the whole
 * engine is unit-testable with a fake document/plugin deps.
 *
 * Guard order on every keydown (spec decision: 焦点与输入法判定):
 *  1. IME — `ev.isComposing` or the self-maintained composing flag suppresses
 *     EVERY binding (US-6: 组字期间确认回车不被劫持). The two engine
 *     families order composition events differently: Safari/WebKit fires
 *     compositionend BEFORE the final commit keydown of a composition, while
 *     Chrome/Firefox fire the commit keydown INSIDE the composition
 *     (ev.isComposing=true) and compositionend only after. Both are covered
 *     time-boxed: composing stays true from compositionstart to
 *     compositionend, and compositionend arms a 0ms-timer suppress that
 *     swallows only the keydown arriving synchronously right after it —
 *     WebKit's commit keydown is that keydown, and the timer clears before
 *     any later real key. Without the timer, a Chrome/Firefox user's next
 *     genuine keydown after an IME confirmation would be wrongly swallowed.
 *  2. Escape — a bare Escape keydown consults onEscape(); when the owner
 *     consumes it (help overlay open) we preventDefault + stopPropagation in
 *     the capture phase so our Escape wins over sibling document handlers
 *     (US-8). IME-guarded like everything else.
 *  3. Binding match — exact modifier set via the pure matcher. A textual
 *     binding — no meta/ctrl/alt/cmdOrCtrl modifier, i.e. a bare key or a
 *     Shift-only combo — skips while an editable element holds focus (US-5:
 *     打字时 `/` 不触发; typing `?` must not open the help overlay either,
 *     since Shift+? produces a printable character); modifier combos fire
 *     regardless (policy B, VS Code-like — the composer holds focus most of
 *     the time, US-7).
 *
 * Dispatch: on a match we preventDefault + stopPropagation (capture listener,
 * capture flag) so the browser action neither fires nor leaks to other
 * handlers, then invoke onAction. All listeners live on `document` with
 * capture=true and are removed by dispose(); the plugin wires attach() into a
 * ctx.effect cleanup so fiber teardown restores the page (HMR-safe).
 */
import { matchesBinding, type ActionId, type ParsedBinding, type Platform } from '../pure.ts'

/** Engine dependencies; `platform` injectable so tests simulate both families. */
export interface ShortcutEngineDeps {
  readonly document: Document
  readonly platform: Platform
  /** Invoked on a matched keydown, after preventDefault + stopPropagation. */
  readonly onAction: (action: ActionId, ev: KeyboardEvent) => void
  /**
   * Consulted on a bare Escape keydown (no modifiers, not composing). Return
   * true to consume the key (preventDefault + stopPropagation) — the help
   * overlay closes here so Escape wins over other document handlers.
   */
  readonly onEscape?: (ev: KeyboardEvent) => boolean
  /**
   * Timer impl for the IME suppress time-box; injectable so specs can run
   * without fake timers. Defaults to the global setTimeout (0ms).
   */
  readonly setTimeout?: (handler: () => void, timeout?: number) => ReturnType<typeof setTimeout>
}

export class ShortcutEngine {
  private readonly deps: ShortcutEngineDeps
  private bindings: Partial<Record<ActionId, ParsedBinding>> = {}
  /** Self-maintained composition flag: true from compositionstart to compositionend. */
  private composing = false
  /**
   * Armed by compositionend and cleared by a 0ms timer — swallows only the
   * WebKit commit keydown that arrives synchronously after compositionend,
   * then clears before any later real keydown (Chrome/Firefox safe).
   */
  private suppressNextKeydown = false
  /** Handle of the suppress time-box; cleared in dispose(). */
  private suppressTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private readonly onKeydown = (ev: KeyboardEvent): void => this.handleKeydown(ev)
  private readonly onCompositionStart = (): void => { this.composing = true }
  private readonly onCompositionEnd = (): void => {
    this.composing = false
    this.suppressNextKeydown = true
    // Re-arm safely: a pending box from an earlier composition is dropped.
    if (this.suppressTimer !== null) clearTimeout(this.suppressTimer)
    this.suppressTimer = (this.deps.setTimeout ?? setTimeout)(() => {
      this.suppressNextKeydown = false
      this.suppressTimer = null
    }, 0)
  }

  constructor(deps: ShortcutEngineDeps) {
    this.deps = deps
  }

  /** Register the three capture listeners. Disposed engines are inert. */
  attach(): void {
    if (this.disposed) return
    const { document } = this.deps
    document.addEventListener('keydown', this.onKeydown, true)
    document.addEventListener('compositionstart', this.onCompositionStart, true)
    document.addEventListener('compositionend', this.onCompositionEnd, true)
  }

  /** Replace the parsed binding set (called when the host config arrives). */
  setBindings(bindings: Partial<Record<ActionId, ParsedBinding>>): void {
    this.bindings = bindings
  }

  /** Remove every listener; further keydowns are ignored. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.suppressTimer !== null) {
      clearTimeout(this.suppressTimer)
      this.suppressTimer = null
    }
    const { document } = this.deps
    document.removeEventListener('keydown', this.onKeydown, true)
    document.removeEventListener('compositionstart', this.onCompositionStart, true)
    document.removeEventListener('compositionend', this.onCompositionEnd, true)
  }

  private handleKeydown(ev: KeyboardEvent): void {
    if (this.disposed) return
    // Guard 1 — IME suppression. `ev.isComposing` marks a keydown inside an
    // active composition (Chrome/Firefox fire the commit keydown here);
    // `composing` covers the gap between compositionstart and compositionend,
    // and `suppressNextKeydown` is the WebKit-bridge armed by compositionend
    // and cleared by a 0ms timer — it swallows exactly the commit keydown
    // arriving synchronously after compositionend and nothing later (US-6).
    if (ev.isComposing || this.composing || this.suppressNextKeydown) return
    // Guard 2 — bare Escape before any binding match (US-8).
    if (ev.key === 'Escape' && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey && !ev.altKey
      && this.deps.onEscape?.(ev) === true) {
      ev.preventDefault()
      ev.stopPropagation()
      return
    }
    // Guard 3 — binding match with the exact modifier set (pure matcher).
    for (const [action, parsed] of Object.entries(this.bindings) as Array<[ActionId, ParsedBinding]>) {
      if (!matchesBinding(parsed, ev, this.deps.platform)) continue
      // Textual bindings (bare keys and Shift-only combos produce printable
      // characters) must not fire while typing into an editable target (US-5,
      // and typing `?` must not open the help overlay). Modifier combos
      // bypass the focus guard entirely (policy B).
      if (this.isTextualBinding(parsed) && this.isEditableTarget(ev)) continue
      ev.preventDefault()
      ev.stopPropagation()
      this.deps.onAction(action, ev)
      return
    }
  }

  /**
   * A binding with no meta/ctrl/alt/cmdOrCtrl modifier is a textual binding
   * (a bare key or a Shift-only combo): it types a printable character, so it
   * is guarded against editable targets.
   */
  private isTextualBinding(parsed: ParsedBinding): boolean {
    return !parsed.meta && !parsed.ctrl && !parsed.alt && !parsed.cmdOrCtrl
  }

  /**
   * Whether the event's focused element (ev.target first, else the active
   * element) accepts text: input, textarea, or any contentEditable element.
   */
  private isEditableTarget(ev: KeyboardEvent): boolean {
    const { document } = this.deps
    const el = ev.target instanceof Element ? ev.target : document.activeElement
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return true
    return el instanceof HTMLElement && el.isContentEditable
  }
}