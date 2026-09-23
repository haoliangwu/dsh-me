/**
 * dsh-ui-shortcuts pure core: the platform-neutral binding grammar shared by
 * the host-half Config validation (bad syntax must fail at startup, spec US-10)
 * and the browser-half matching engine. Zero I/O and zero DOM — the matcher
 * receives a plain modifier/key record, so vitest covers every branch in both
 * halves without a document. A binding is `Modifier+Modifier+Key` with the
 * last token the key; `CmdOrCtrl` resolves to meta on macOS and ctrl elsewhere
 * (spec US-14). Matching demands the EXACT modifier set — no extra held
 * modifiers — and `ev.key` compare that is case-sensitive for non-letters
 * (`?` must never match `/`) and case-insensitive for single letters.
 */

/** A resolved action id. */
export type ActionId = 'sidebar' | 'rightbar' | 'focus' | 'help'

/** The two platform families the matcher and display path distinguish. */
export type Platform = 'mac' | 'other'

/** How a modifier token maps onto the parsed flag set. */
type ModifierKind = 'meta' | 'ctrl' | 'shift' | 'alt' | 'cmdOrCtrl'

/** Case-insensitive modifier tokens → flag kind. */
const MODIFIERS: Readonly<Record<string, ModifierKind>> = {
  'cmdorctrl': 'cmdOrCtrl',
  'cmd': 'meta',
  'meta': 'meta',
  'ctrl': 'ctrl',
  'shift': 'shift',
  'alt': 'alt',
  'option': 'alt',
}

/** Named keys (multi-char) the grammar accepts; `Space` maps to `ev.key === ' '`. */
const NAMED_KEYS = new Set([
  'escape', 'enter', 'tab', 'backspace', 'delete', 'insert', 'home', 'end',
  'pageup', 'pagedown', 'space',
  'arrowup', 'arrowdown', 'arrowleft', 'arrowright',
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
])

/** A parsed, platform-neutral binding: normalized key + written modifier flags. */
export interface ParsedBinding {
  /** The trigger key as written: one character, or a named key in any case. */
  readonly key: string
  /** Explicit `Cmd`/`Meta` modifier. */
  readonly meta: boolean
  /** Explicit `Ctrl` modifier. */
  readonly ctrl: boolean
  /** Explicit `Shift` modifier. */
  readonly shift: boolean
  /** Explicit `Alt`/`Option` modifier. */
  readonly alt: boolean
  /** Platform-neutral primary modifier: meta on mac, ctrl elsewhere. */
  readonly cmdOrCtrl: boolean
}

/** The modifier/key event face `matchesBinding` reads (KeyboardEvent is structurally compatible). */
export interface ShortcutEventLike {
  readonly key: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly shiftKey: boolean
  readonly altKey: boolean
}

/** Raised on binding grammar violations; the host Config re-throws it as a z.ValidationError. */
export class ShortcutsBindingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ShortcutsBindingError'
  }
}

/**
 * Parse one binding string (e.g. `'CmdOrCtrl+Shift+K'`). Modifier tokens are
 * case-insensitive; the key is the last token and must be a single character
 * or a named key. Unknown modifiers, empty keys, duplicate modifiers, and a
 * missing key all throw {@link ShortcutsBindingError} with a pinpoint message.
 */
export function parseBinding(input: string): ParsedBinding {
  if (input.trim() === '') throw new ShortcutsBindingError(`binding must not be empty, got '${input}'`)
  const tokens = input.split('+')
  const keyToken = (tokens.at(-1) as string).trim()
  if (keyToken === '') throw new ShortcutsBindingError(`binding '${input}' has an empty key (trailing '+')`)
  if (MODIFIERS[keyToken.toLowerCase()] !== undefined) {
    throw new ShortcutsBindingError(`binding '${input}' ends with modifier '${keyToken}'; a key token is required`)
  }
  const flags: { meta: boolean; ctrl: boolean; shift: boolean; alt: boolean; cmdOrCtrl: boolean } = {
    meta: false, ctrl: false, shift: false, alt: false, cmdOrCtrl: false,
  }
  for (const raw of tokens.slice(0, -1)) {
    const token = raw.trim()
    const kind = MODIFIERS[token.toLowerCase()]
    if (kind === undefined) throw new ShortcutsBindingError(`unknown modifier '${token}' in binding '${input}'`)
    if (flags[kind]) throw new ShortcutsBindingError(`duplicate modifier '${token}' in binding '${input}'`)
    flags[kind] = true
  }
  const isSingleChar = [...keyToken].length === 1
  if (!isSingleChar && !NAMED_KEYS.has(keyToken.toLowerCase())) {
    throw new ShortcutsBindingError(`unknown key '${keyToken}' in binding '${input}': use one character or a named key (e.g. Escape, ArrowUp, F5)`)
  }
  return { key: keyToken, ...flags }
}

/**
 * Whether one keydown event fires the parsed binding. The event's full
 * modifier set must equal the binding's resolved set exactly — holding an
 * extra modifier (e.g. Shift beside CmdOrCtrl+B) kills the match (spec guard
 * policy A). Key compare: case-insensitive for single letters and named keys,
 * exact for punctuation so `Shift+?` never matches `/`.
 */
export function matchesBinding(parsed: ParsedBinding, ev: ShortcutEventLike, platform: Platform): boolean {
  const wantMeta = parsed.meta || (parsed.cmdOrCtrl && platform === 'mac')
  const wantCtrl = parsed.ctrl || (parsed.cmdOrCtrl && platform === 'other')
  if (ev.metaKey !== wantMeta || ev.ctrlKey !== wantCtrl
    || ev.shiftKey !== parsed.shift || ev.altKey !== parsed.alt) return false
  return keyMatches(parsed.key, ev.key)
}

/**
 * Key comparison per the case rules above. Fullwidth forms (U+FF01–U+FF5E,
 * plus U+3000) fold to their halfwidth twins first: a CJK IME in Chinese mode
 * emits Shift+/ as `？` (U+FF1F) with no composition events, so the guard
 * stack passes but the raw compare would miss a halfwidth `?` binding.
 */
function keyMatches(bindingKey: string, eventKey: string): boolean {
  if (bindingKey.length === 1) {
    const key = foldFullwidth(bindingKey)
    return /^[a-zA-Z]$/.test(key)
      ? key.toLowerCase() === foldFullwidth(eventKey).toLowerCase()
      : key === foldFullwidth(eventKey)
  }
  const folded = foldFullwidth(eventKey)
  const normalized = folded === ' ' ? 'space' : folded.toLowerCase()
  return foldFullwidth(bindingKey).toLowerCase() === normalized
}

/** Fold one fullwidth ASCII-range char to its halfwidth twin; others pass through. */
function foldFullwidth(ch: string): string {
  const code = ch.codePointAt(0) ?? 0
  if (code >= 0xff01 && code <= 0xff5e) return String.fromCodePoint(code - 0xfee0)
  if (code === 0x3000) return ' '
  return ch
}

/**
 * Render a binding for the help overlay: `⌘`/`Ctrl` per platform for
 * `CmdOrCtrl` (spec US-14), symbols for Shift/Alt on mac (glyphs concatenate
 * without separators, matching platform convention), the key uppercased when
 * it is a single letter, and `+` separators on other platforms.
 */
export function displayBinding(binding: string, platform: Platform): string {
  const parsed = parseBinding(binding)
  const parts: string[] = []
  if (parsed.cmdOrCtrl) parts.push(platform === 'mac' ? '⌘' : 'Ctrl')
  if (parsed.meta) parts.push(platform === 'mac' ? '⌘' : 'Meta')
  if (parsed.ctrl) parts.push('Ctrl')
  if (parsed.shift) parts.push(platform === 'mac' ? '⇧' : 'Shift')
  if (parsed.alt) parts.push(platform === 'mac' ? '⌥' : 'Alt')
  parts.push(displayKey(parsed.key))
  return parts.join(platform === 'mac' ? '' : '+')
}

/** Key display: `Space` for the space char, uppercase for a single letter, verbatim otherwise. */
function displayKey(key: string): string {
  if (key === ' ') return 'Space'
  return /^[a-zA-Z]$/.test(key) ? key.toUpperCase() : key
}