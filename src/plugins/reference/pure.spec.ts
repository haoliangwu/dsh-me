import { describe, expect, it } from 'vitest'
import {
  aliasValidationError,
  buildAdvertisementText,
  candidateEntries,
  normalizeTable,
  referencePathError,
  resolveReferencePath,
  serializeMention,
} from './pure.ts'

const HOME = '/Users/u'

describe('aliasValidationError', () => {
  it('accepts a plain alias', () => {
    expect(aliasValidationError('docs')).toBeUndefined()
  })

  it('accepts aliases with dots and non-ASCII', () => {
    expect(aliasValidationError('a.b-c_1')).toBeUndefined()
    expect(aliasValidationError('中文资料')).toBeUndefined()
  })

  it('rejects an empty alias', () => {
    expect(aliasValidationError('')).toBe('不能为空')
  })

  it('rejects a forward slash', () => {
    expect(aliasValidationError('a/b')).toBe('不能包含 /、\\、空白、反引号或逗号')
  })

  it('rejects a backslash', () => {
    expect(aliasValidationError('a\\b')).toBe('不能包含 /、\\、空白、反引号或逗号')
  })

  it('rejects whitespace (space and tab)', () => {
    expect(aliasValidationError('a b')).toBe('不能包含 /、\\、空白、反引号或逗号')
    expect(aliasValidationError('a\tb')).toBe('不能包含 /、\\、空白、反引号或逗号')
  })

  it('rejects a backtick', () => {
    expect(aliasValidationError('a`b')).toBe('不能包含 /、\\、空白、反引号或逗号')
  })

  it('rejects a comma', () => {
    expect(aliasValidationError('a,b')).toBe('不能包含 /、\\、空白、反引号或逗号')
  })
})

describe('referencePathError', () => {
  it('accepts an absolute path', () => {
    expect(referencePathError('/Users/u/docs')).toBeUndefined()
    expect(referencePathError('/')).toBeUndefined()
  })

  it('accepts a ~/ path', () => {
    expect(referencePathError('~/docs')).toBeUndefined()
  })

  it('rejects a relative path with an explicit reason', () => {
    expect(referencePathError('docs/x')).toBe('必须用绝对路径或 ~/ 开头')
    expect(referencePathError('x')).toBe('必须用绝对路径或 ~/ 开头')
  })

  it('rejects a bare tilde', () => {
    expect(referencePathError('~docs')).toBe('必须用绝对路径或 ~/ 开头')
  })

  it('rejects an empty path', () => {
    expect(referencePathError('')).toBe('必须用绝对路径或 ~/ 开头')
  })
})

describe('resolveReferencePath', () => {
  it('expands ~/ to home', () => {
    expect(resolveReferencePath('~/docs', HOME)).toBe('/Users/u/docs')
    expect(resolveReferencePath('~/docs/x', HOME)).toBe('/Users/u/docs/x')
  })

  it('passes an absolute path through', () => {
    expect(resolveReferencePath('/var/cache/refs', HOME)).toBe('/var/cache/refs')
  })
})

describe('normalizeTable', () => {
  it('returns an empty table for undefined, null, or a non-object', () => {
    expect(normalizeTable(undefined)).toEqual({})
    expect(normalizeTable(null)).toEqual({})
    expect(normalizeTable('nope')).toEqual({})
  })

  it('defaults hidden to false', () => {
    expect(normalizeTable({ docs: { path: '/Users/u/docs' } })).toEqual({
      docs: { path: '/Users/u/docs', hidden: false },
    })
  })

  it('preserves an explicit hidden flag', () => {
    expect(normalizeTable({ docs: { path: '/Users/u/docs', hidden: true } })).toEqual({
      docs: { path: '/Users/u/docs', hidden: true },
    })
  })

  it('keeps a non-empty description and drops an empty one', () => {
    expect(normalizeTable({ docs: { path: '/x', description: '产品文档库' } })).toEqual({
      docs: { path: '/x', description: '产品文档库', hidden: false },
    })
    expect(normalizeTable({ docs: { path: '/x', description: '' } })).toEqual({
      docs: { path: '/x', hidden: false },
    })
  })

  it('skips a non-object entry and an entry without a string path', () => {
    expect(normalizeTable({ docs: '/plain-string', bad: { hidden: true } })).toEqual({})
  })
})

describe('buildAdvertisementText', () => {
  it('returns an empty string for an empty table', () => {
    expect(buildAdvertisementText({}, HOME)).toBe('')
  })

  it('advertises an entry without a description (name/path only, no <description>)', () => {
    const table = { docs: { path: '/Users/u/docs', description: undefined, hidden: false } }
    expect(buildAdvertisementText(table, HOME)).toBe(
      'Project references provide additional directories that can be accessed when relevant.\n'
      + '<available_references>\n'
      + '  <reference>\n'
      + '    <name>docs</name>\n'
      + '    <path>/Users/u/docs</path>\n'
      + '  </reference>\n'
      + '</available_references>',
    )
  })

  it('advertises hidden entries that carry a description (OC semantics)', () => {
    const table = {
      quiet: { path: '/Users/u/rare', description: '低频资料', hidden: true },
    }
    expect(buildAdvertisementText(table, HOME)).toBe(
      'Project references provide additional directories that can be accessed when relevant.\n'
      + '<available_references>\n'
      + '  <reference>\n'
      + '    <name>quiet</name>\n'
      + '    <path>/Users/u/rare</path>\n'
      + '    <description>低频资料</description>\n'
      + '  </reference>\n'
      + '</available_references>',
    )
  })

  it('lists entries with the resolved path, sorts by alias, omits <description> for description-less ones', () => {
    const table = {
      zeta: { path: '/Users/u/z', description: 'Z 资料', hidden: false },
      noshow: { path: '/Users/u/n', description: undefined, hidden: false },
      alpha: { path: '~/a', description: 'A 资料', hidden: false },
    }
    expect(buildAdvertisementText(table, HOME)).toBe(
      'Project references provide additional directories that can be accessed when relevant.\n'
      + '<available_references>\n'
      + '  <reference>\n'
      + '    <name>alpha</name>\n'
      + '    <path>/Users/u/a</path>\n'
      + '    <description>A 资料</description>\n'
      + '  </reference>\n'
      + '  <reference>\n'
      + '    <name>noshow</name>\n'
      + '    <path>/Users/u/n</path>\n'
      + '  </reference>\n'
      + '  <reference>\n'
      + '    <name>zeta</name>\n'
      + '    <path>/Users/u/z</path>\n'
      + '    <description>Z 资料</description>\n'
      + '  </reference>\n'
      + '</available_references>',
    )
  })
})

describe('candidateEntries', () => {
  it('returns an empty list for an empty table', () => {
    expect(candidateEntries({}, HOME)).toEqual([])
  })

  it('drops hidden entries', () => {
    const table = {
      keep: { path: '/Users/u/k', description: 'K', hidden: false },
      quiet: { path: '/Users/u/q', description: 'Q', hidden: true },
    }
    expect(candidateEntries(table, HOME)).toEqual([{ alias: 'keep', path: '/Users/u/k', description: 'K' }])
  })

  it('resolves ~/ paths and sorts by alias', () => {
    const table = {
      b: { path: '~/b', hidden: false },
      a: { path: '/Users/u/a', description: 'A', hidden: false },
    }
    expect(candidateEntries(table, HOME)).toEqual([
      { alias: 'a', path: '/Users/u/a', description: 'A' },
      { alias: 'b', path: '/Users/u/b' },
    ])
  })
})

describe('serializeMention', () => {
  it('emits @<path> for a plain path', () => {
    expect(serializeMention('/Users/u/docs')).toBe('@/Users/u/docs')
  })

  it('quotes a path containing whitespace', () => {
    expect(serializeMention('/Users/u/my docs')).toBe('@"/Users/u/my docs"')
  })

  it('quotes a path containing a tab', () => {
    expect(serializeMention('/Users/u/a\tb')).toBe('@"/Users/u/a\tb"')
  })
})