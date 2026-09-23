/**
 * dsh-ui-shortcuts pure-core tests: the binding grammar (parse), the exact-set
 * matcher (including the CmdOrCtrl platform split), and the display renderer.
 * The guard policy lives in the engine and is exercised at the apply level.
 */
import { describe, expect, it } from 'vitest'
import {
  ShortcutsBindingError,
  displayBinding,
  matchesBinding,
  parseBinding,
  type Platform,
  type ShortcutEventLike,
} from './pure.ts'

/** One keydown record; modifiers default off. */
function ev(overrides: Partial<ShortcutEventLike> = {}): ShortcutEventLike {
  return { key: 'a', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...overrides }
}

describe('parseBinding: valid grammar', () => {
  it('parses a platform-neutral combo', () => {
    expect(parseBinding('CmdOrCtrl+B')).toEqual({
      key: 'B', meta: false, ctrl: false, shift: false, alt: false, cmdOrCtrl: true,
    })
  })

  it('parses Shift+? with a punctuation key', () => {
    expect(parseBinding('Shift+?')).toEqual({
      key: '?', meta: false, ctrl: false, shift: true, alt: false, cmdOrCtrl: false,
    })
  })

  it('parses a single-key binding without modifiers', () => {
    expect(parseBinding('?').shift).toBe(false)
    expect(parseBinding('?').cmdOrCtrl).toBe(false)
  })

  it('accepts modifier tokens case-insensitively and Option as Alt', () => {
    expect(parseBinding('cmdorctrl+option+b').alt).toBe(true)
    expect(parseBinding('cmdorctrl+option+b').cmdOrCtrl).toBe(true)
    expect(parseBinding('ALT+CTRL+SHIFT+k')).toMatchObject({ alt: true, ctrl: true, shift: true })
    expect(parseBinding('CMD+SHIFT+B')).toMatchObject({ meta: true, shift: true })
  })

  it('accepts named keys', () => {
    expect(parseBinding('Ctrl+Shift+ArrowUp').key).toBe('ArrowUp')
    expect(parseBinding('Escape').key).toBe('Escape')
    expect(parseBinding('Shift+F5').key).toBe('F5')
    expect(parseBinding('Ctrl+Space').key).toBe('Space')
  })

  it('accepts Cmd as an explicit meta modifier', () => {
    expect(parseBinding('Cmd+Shift+K')).toMatchObject({ meta: true, shift: true, cmdOrCtrl: false })
  })
})

describe('parseBinding: error cases', () => {
  it('rejects an empty binding', () => {
    expect(() => parseBinding('')).toThrow(ShortcutsBindingError)
    expect(() => parseBinding('   ')).toThrow(/empty/)
  })

  it('rejects an empty key (trailing plus)', () => {
    expect(() => parseBinding('Ctrl+')).toThrow(/empty key/)
  })

  it('rejects an unknown modifier token', () => {
    expect(() => parseBinding('Ctrl+Shift+Foo+B')).toThrow(/unknown modifier 'Foo'/)
  })

  it('rejects an unknown multi-char key', () => {
    expect(() => parseBinding('CmdOrCtrl+Bogus')).toThrow(/unknown key 'Bogus'/)
  })

  it('rejects a binding whose last token is a modifier', () => {
    expect(() => parseBinding('Ctrl+Shift')).toThrow(/key token is required/)
  })

  it('rejects a duplicate modifier token', () => {
    expect(() => parseBinding('Shift+Shift+K')).toThrow(/duplicate modifier/)
  })
})

describe('matchesBinding: exact modifier set', () => {
  it('fires only with the exact modifiers — extra Shift kills the match', () => {
    const parsed = parseBinding('CmdOrCtrl+B')
    const onMac = 'mac' as Platform
    expect(matchesBinding(parsed, ev({ key: 'b', metaKey: true }), onMac)).toBe(true)
    expect(matchesBinding(parsed, ev({ key: 'b', metaKey: true, shiftKey: true }), onMac)).toBe(false)
  })

  it('Shift+? does not match a plain ? and vice versa', () => {
    const shifted = parseBinding('Shift+?')
    const plain = parseBinding('?')
    expect(matchesBinding(shifted, ev({ key: '?' }), 'other')).toBe(false)
    expect(matchesBinding(shifted, ev({ key: '?', shiftKey: true }), 'other')).toBe(true)
    expect(matchesBinding(plain, ev({ key: '?', shiftKey: true }), 'other')).toBe(false)
    expect(matchesBinding(plain, ev({ key: '?' }), 'other')).toBe(true)
  })

  it('is case-sensitive for punctuation — ? never matches /', () => {
    expect(matchesBinding(parseBinding('Shift+?'), ev({ key: '/', shiftKey: true }), 'other')).toBe(false)
  })

  it('is case-insensitive for single letters', () => {
    expect(matchesBinding(parseBinding('CmdOrCtrl+B'), ev({ key: 'B', metaKey: true }), 'mac')).toBe(true)
    expect(matchesBinding(parseBinding('CmdOrCtrl+B'), ev({ key: 'b', metaKey: true }), 'mac')).toBe(true)
  })

  it('matches named keys case-insensitively', () => {
    expect(matchesBinding(parseBinding('Escape'), ev({ key: 'Escape' }), 'other')).toBe(true)
  })

  it('maps named Space to the space event key', () => {
    expect(matchesBinding(parseBinding('Space'), ev({ key: ' ' }), 'other')).toBe(true)
  })
})

describe('matchesBinding: CmdOrCtrl platform split (spec US-14)', () => {
  const parsed = parseBinding('CmdOrCtrl+B')

  it('resolves to meta on mac, ctrl elsewhere', () => {
    expect(matchesBinding(parsed, ev({ key: 'b', metaKey: true }), 'mac')).toBe(true)
    expect(matchesBinding(parsed, ev({ key: 'b', ctrlKey: true }), 'mac')).toBe(false)
    expect(matchesBinding(parsed, ev({ key: 'b', ctrlKey: true }), 'other')).toBe(true)
    expect(matchesBinding(parsed, ev({ key: 'b', metaKey: true }), 'other')).toBe(false)
  })
})

describe('displayBinding', () => {
  it('renders ⌘ on mac and Ctrl elsewhere', () => {
    expect(displayBinding('CmdOrCtrl+B', 'mac')).toBe('⌘B')
    expect(displayBinding('CmdOrCtrl+B', 'other')).toBe('Ctrl+B')
  })

  it('renders symbols for the mac modifiers and uppercases letters', () => {
    expect(displayBinding('CmdOrCtrl+Shift+K', 'mac')).toBe('⌘⇧K')
    expect(displayBinding('CmdOrCtrl+Shift+K', 'other')).toBe('Ctrl+Shift+K')
  })

  it('preserves punctuation keys and named keys', () => {
    expect(displayBinding('Shift+?', 'mac')).toBe('⇧?')
    expect(displayBinding('Escape', 'other')).toBe('Escape')
  })
})