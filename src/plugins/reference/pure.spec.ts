import { describe, expect, it } from 'vitest'
import {
  aliasValidationError,
  branchValidationError,
  buildAdvertisementText,
  candidateEntries,
  defaultCacheDir,
  dirnameOf,
  entryShapeError,
  gitSpecsOf,
  isFileRepository,
  joinPath,
  materializeGit,
  normalizeTable,
  referencePathError,
  resolveCacheDir,
  resolveEntryPath,
  resolveReferencePath,
  serializeMention,
  type GitDeps,
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

describe('entryShapeError (XOR { path } / { repository, branch? })', () => {
  it('accepts a local entry', () => {
    expect(entryShapeError({ path: '/Users/u/docs' })).toBeUndefined()
  })

  it('accepts a git entry with optional branch and refresh', () => {
    expect(entryShapeError({ repository: 'https://x/y.git' })).toBeUndefined()
    expect(entryShapeError({ repository: 'https://x/y.git', branch: 'main' })).toBeUndefined()
    expect(entryShapeError({ repository: 'https://x/y.git', branch: 'main', refresh: 'always' })).toBeUndefined()
  })

  it('rejects an empty entry (neither form)', () => {
    expect(entryShapeError({})).toContain('必须二选一')
  })

  it('rejects a mixed entry (both forms)', () => {
    expect(entryShapeError({ path: '/x', repository: 'https://x/y.git' })).toContain('必须二选一')
  })

  it('rejects a file:// repository', () => {
    expect(entryShapeError({ repository: 'file:///tmp/repo' })).toContain('file://')
  })

  it('rejects a file: repository', () => {
    expect(entryShapeError({ repository: 'file:relative' })).toContain('file://')
  })

  it('rejects an empty repository', () => {
    expect(entryShapeError({ repository: '' })).toContain('repository 不能为空')
  })

  it('rejects a branch with whitespace or git-forbidden punctuation', () => {
    expect(entryShapeError({ repository: 'https://x/y.git', branch: 'm ain' })).toContain('空白')
    expect(entryShapeError({ repository: 'https://x/y.git', branch: 'a~b' })).toContain('禁用')
    expect(entryShapeError({ repository: 'https://x/y.git', branch: 'a..b' })).toContain('..')
    expect(entryShapeError({ repository: 'https://x/y.git', branch: 'a/' })).toContain('/')
  })

  it('accepts an empty branch string (treated as the default branch)', () => {
    expect(entryShapeError({ repository: 'https://x/y.git', branch: '' })).toBeUndefined()
  })

  it('rejects a non-string branch', () => {
    const error = entryShapeError({ repository: 'https://x/y.git', branch: 7 })
    expect(error).toContain('branch')
  })

  it('rejects a refresh outside the const-union', () => {
    const error = entryShapeError({ repository: 'https://x/y.git', refresh: 'sometimes' })
    expect(error).toContain('refresh')
    expect(error).toContain('always')
  })

  it('accepts a missing "path"-typed repository value as the empty form', () => {
    expect(entryShapeError({ repository: 7 })).toContain('必须二选一')
  })
})

describe('isFileRepository', () => {
  it('detects file:// and file: URIs', () => {
    expect(isFileRepository('file:///tmp/r')).toBe(true)
    expect(isFileRepository('file:r')).toBe(true)
  })

  it('passes ordinary remotes', () => {
    expect(isFileRepository('https://x/y.git')).toBe(false)
    expect(isFileRepository('git@github.com:x/y.git')).toBe(false)
    expect(isFileRepository('/tmp/r')).toBe(false)
  })
})

describe('branchValidationError', () => {
  it('accepts plain branch names incl. segment slashes', () => {
    expect(branchValidationError('main')).toBeUndefined()
    expect(branchValidationError('feature/x-1')).toBeUndefined()
    expect(branchValidationError('release-v2.0')).toBeUndefined()
  })

  it('rejects an empty branch', () => {
    expect(branchValidationError('')).toContain('不能为空')
  })

  it('rejects whitespace', () => {
    expect(branchValidationError('m ain')).toContain('空白')
    expect(branchValidationError('a\tb')).toContain('空白')
  })

  it('rejects git-forbidden punctuation', () => {
    expect(branchValidationError('a\\b')).toContain('禁用')
    expect(branchValidationError('a~b')).toContain('禁用')
    expect(branchValidationError('a:b')).toContain('禁用')
    expect(branchValidationError('a?b')).toContain('禁用')
    expect(branchValidationError('a*b')).toContain('禁用')
    expect(branchValidationError('a[b')).toContain('禁用')
  })

  it('rejects leading/trailing or doubled slashes', () => {
    expect(branchValidationError('/a')).toContain('/')
    expect(branchValidationError('a/')).toContain('/')
    expect(branchValidationError('a//b')).toContain('/')
  })

  it('rejects ..', () => {
    expect(branchValidationError('a..b')).toContain('..')
    expect(branchValidationError('..')).toContain('..')
  })
})

describe('resolveCacheDir / defaultCacheDir', () => {
  it('defaults to ~/.cache/dsh-me/references', () => {
    expect(defaultCacheDir(HOME)).toBe('/Users/u/.cache/dsh-me/references')
    expect(resolveCacheDir(undefined, HOME)).toBe('/Users/u/.cache/dsh-me/references')
  })

  it('expands ~/ and passes absolute paths through', () => {
    expect(resolveCacheDir('~/refs-cache', HOME)).toBe('/Users/u/refs-cache')
    expect(resolveCacheDir('/var/cache/refs', HOME)).toBe('/var/cache/refs')
  })

  it('returns undefined for a relative cacheDir (caller falls back + logs)', () => {
    expect(resolveCacheDir('relative/cache', HOME)).toBeUndefined()
  })
})

describe('joinPath / dirnameOf (no Node builtins)', () => {
  it('joins segments with a single slash', () => {
    expect(joinPath('/a', 'b', 'c')).toBe('/a/b/c')
    expect(joinPath('/a/', 'b')).toBe('/a/b')
    expect(joinPath('', 'b')).toBe('b')
    expect(joinPath('/a', '')).toBe('/a')
    expect(joinPath('/')).toBe('/')
  })

  it('keeps the leading slash of an absolute first part (git cache paths)', () => {
    expect(joinPath('/Users/u/.cache/dsh-me/references', 'repo')).toBe('/Users/u/.cache/dsh-me/references/repo')
    expect(joinPath('/.cache', 'repo')).toBe('/.cache/repo')
  })

  it('derives the parent directory (dirname subset)', () => {
    expect(dirnameOf('/cache/repo')).toBe('/cache')
    expect(dirnameOf('/cache/a/b')).toBe('/cache/a')
    expect(dirnameOf('/repo')).toBe('/')
    expect(dirnameOf('/')).toBe('/')
  })
})

describe('resolveEntryPath', () => {
  it('resolves a local entry through the path rules', () => {
    expect(resolveEntryPath('docs', { path: '~/docs', hidden: false }, HOME, '/cache')).toBe('/Users/u/docs')
    expect(resolveEntryPath('docs', { path: '/abs/docs', hidden: false }, HOME, '/cache')).toBe('/abs/docs')
  })

  it('resolves a git entry to <cacheDir>/<alias>', () => {
    expect(resolveEntryPath('repo', { repository: 'https://x/y.git', hidden: false }, HOME, '/cache')).toBe('/cache/repo')
    expect(resolveEntryPath('repo', { repository: 'https://x/y.git', hidden: false }, HOME, defaultCacheDir(HOME)))
      .toBe('/Users/u/.cache/dsh-me/references/repo')
  })
})

describe('normalizeTable git entries', () => {
  it('keeps a git entry with branch, refresh, description, and hidden', () => {
    expect(normalizeTable({
      repo: { repository: 'https://x/y.git', branch: 'main', refresh: 'always', description: 'Y 仓库', hidden: true },
    })).toEqual({
      repo: { repository: 'https://x/y.git', branch: 'main', refresh: 'always', description: 'Y 仓库', hidden: true },
    })
  })

  it('keeps a bare git entry (no branch/refresh)', () => {
    expect(normalizeTable({ repo: { repository: 'https://x/y.git' } })).toEqual({
      repo: { repository: 'https://x/y.git', hidden: false },
    })
  })

  it('drops a file:// git entry and an entry with neither form', () => {
    expect(normalizeTable({
      bad: { repository: 'file:///tmp/r' },
      neither: { hidden: true },
    })).toEqual({})
  })

  it('drops an empty repository string', () => {
    expect(normalizeTable({ bad: { repository: '' } })).toEqual({})
  })
})

describe('gitSpecsOf', () => {
  it('flattens git entries with deterministic cache paths and the global default refresh', () => {
    const table = {
      local: { path: '/x', hidden: false },
      repo: { repository: 'https://x/y.git', branch: 'main', hidden: false },
    }
    expect(gitSpecsOf(table, HOME, '/cache')).toEqual([
      { name: 'repo', repository: 'https://x/y.git', branch: 'main', path: '/cache/repo', refresh: 'missing-only' },
    ])
  })

  it('per-entry refresh overrides the global value', () => {
    const table = {
      a: { repository: 'https://a.git', refresh: 'always' as const, hidden: false },
      b: { repository: 'https://b.git', refresh: 'missing-only' as const, hidden: false },
    }
    expect(gitSpecsOf(table, HOME, '/cache', 'always')).toEqual([
      { name: 'a', repository: 'https://a.git', path: '/cache/a', refresh: 'always' },
      { name: 'b', repository: 'https://b.git', path: '/cache/b', refresh: 'missing-only' },
    ])
  })

  it('yields no specs for an empty table or local-only entries', () => {
    expect(gitSpecsOf({}, HOME, '/cache')).toEqual([])
    expect(gitSpecsOf({ docs: { path: '/x', hidden: false } }, HOME, '/cache')).toEqual([])
  })
})

describe('buildAdvertisementText git entries', () => {
  it('advertises a git entry at its cache path (resolved, not the repository URL)', () => {
    const table = {
      repo: { repository: 'https://x/y.git', description: 'Y 仓库', hidden: false },
    }
    expect(buildAdvertisementText(table, HOME, '/cache')).toBe(
      'Project references provide additional directories that can be accessed when relevant.\n'
      + '<available_references>\n'
      + '  <reference>\n'
      + '    <name>repo</name>\n'
      + '    <path>/cache/repo</path>\n'
      + '    <description>Y 仓库</description>\n'
      + '  </reference>\n'
      + '</available_references>',
    )
  })
})

describe('candidateEntries git entries', () => {
  it('offers git candidates at their cache path, mixed and sorted with local ones', () => {
    const table = {
      zeta: { repository: 'https://z.git', hidden: false },
      alpha: { path: '/Users/u/a', description: 'A', hidden: false },
      quiet: { repository: 'https://q.git', hidden: true },
    }
    expect(candidateEntries(table, HOME, '/cache')).toEqual([
      { alias: 'alpha', path: '/Users/u/a', description: 'A' },
      { alias: 'zeta', path: '/cache/zeta' },
    ])
  })
})

describe('materializeGit (exec stub)', () => {
  const deps = (overrides: Partial<GitDeps> = {}): GitDeps & {
    calls: { args: string[]; cwd: string }[]
    rmCalls: string[]
    writeCalls: { path: string; content: string }[]
  } => {
    const calls: { args: string[]; cwd: string }[] = []
    const rmCalls: string[] = []
    const writeCalls: { path: string; content: string }[] = []
    const innerExec = overrides.exec ?? (async () => '')
    const innerRead = overrides.readFile ?? (() => undefined)
    return {
      calls,
      rmCalls,
      writeCalls,
      exists: () => false,
      mkdir: () => {},
      rm: (path) => { rmCalls.push(path) },
      writeFile: (path, content) => { writeCalls.push({ path, content }) },
      readFile: (path) => innerRead(path),
      ...overrides,
      exec: async (args, options) => {
        calls.push({ args: [...args], cwd: options.cwd })
        return innerExec(args, options)
      },
    }
  }

  it('clones with the branch when the target is absent', async () => {
    const d = deps()
    await materializeGit({ name: 'repo', repository: 'https://x/y.git', branch: 'main', path: '/cache/repo', refresh: 'missing-only' }, d, { info: () => {}, warn: () => {} })
    expect(d.calls).toEqual([{ args: ['clone', '--depth', '1', '-b', 'main', 'https://x/y.git', '/cache/repo'], cwd: '/cache' }])
    expect(d.writeCalls).toEqual([{ path: '/cache/repo/.refs-branch', content: 'main' }])
  })

  it('clones without -b and writes no marker when no branch is set', async () => {
    const d = deps()
    await materializeGit({ name: 'repo', repository: 'https://x/y.git', path: '/cache/repo', refresh: 'missing-only' }, d, { info: () => {}, warn: () => {} })
    expect(d.calls[0]?.args).toEqual(['clone', '--depth', '1', 'https://x/y.git', '/cache/repo'])
    expect(d.writeCalls).toEqual([])
  })

  it('fetches and hard-resets an existing checkout under always', async () => {
    const d = deps({ exists: () => true })
    await materializeGit({ name: 'repo', repository: 'https://x/y.git', branch: 'main', path: '/cache/repo', refresh: 'always' }, d, { info: () => {}, warn: () => {} })
    expect(d.calls).toEqual([
      { args: ['fetch', 'origin'], cwd: '/cache/repo' },
      { args: ['reset', '--hard', 'origin/main'], cwd: '/cache/repo' },
    ])
  })

  it('defaults the reset ref to origin/HEAD under always', async () => {
    const d = deps({ exists: () => true })
    await materializeGit({ name: 'repo', repository: 'https://x/y.git', path: '/cache/repo', refresh: 'always' }, d, { info: () => {}, warn: () => {} })
    expect(d.calls[1]?.args).toEqual(['reset', '--hard', 'origin/HEAD'])
  })

  it('missing-only leaves an existing checkout untouched (no exec at all)', async () => {
    const d = deps({ exists: () => true, readFile: () => 'main' })
    await materializeGit({ name: 'repo', repository: 'https://x/y.git', branch: 'main', path: '/cache/repo', refresh: 'missing-only' }, d, { info: () => {}, warn: () => {} })
    expect(d.calls).toEqual([])
    expect(d.rmCalls).toEqual([])
  })

  it('missing-only leaves a marker-less checkout untouched', async () => {
    const d = deps({ exists: () => true })
    await materializeGit({ name: 'repo', repository: 'https://x/y.git', branch: 'main', path: '/cache/repo', refresh: 'missing-only' }, d, { info: () => {}, warn: () => {} })
    expect(d.calls).toEqual([])
    expect(d.rmCalls).toEqual([])
  })

  it('missing-only re-materializes an existing checkout on branch mismatch', async () => {
    const d = deps({ exists: () => true, readFile: () => 'dev' })
    await materializeGit({ name: 'repo', repository: 'https://x/y.git', branch: 'main', path: '/cache/repo', refresh: 'missing-only' }, d, { info: () => {}, warn: () => {} })
    expect(d.rmCalls).toEqual(['/cache/repo'])
    expect(d.calls).toEqual([{ args: ['clone', '--depth', '1', '-b', 'main', 'https://x/y.git', '/cache/repo'], cwd: '/cache' }])
    expect(d.writeCalls).toEqual([{ path: '/cache/repo/.refs-branch', content: 'main' }])
  })

  it('logs a failed branch detection and leaves the checkout untouched', async () => {
    const warnings: string[] = []
    const d = deps({ exists: () => true, readFile: () => { throw new Error('permission denied') } })
    await expect(materializeGit({ name: 'repo', repository: 'https://x/y.git', branch: 'main', path: '/cache/repo', refresh: 'missing-only' }, d, { info: () => {}, warn: (m) => warnings.push(m) })).resolves.toBeUndefined()
    expect(warnings.join(' ')).toContain('branch detection failed')
    expect(d.calls).toEqual([])
    expect(d.rmCalls).toEqual([])
  })

  it('logs failures instead of throwing', async () => {
    const warnings: string[] = []
    const d = deps({ exists: () => true, exec: async () => { throw new Error('boom') } })
    await expect(materializeGit({ name: 'repo', repository: 'https://x/y.git', path: '/cache/repo', refresh: 'always' }, d, { info: () => {}, warn: (m) => warnings.push(m) })).resolves.toBeUndefined()
    expect(warnings.join(' ')).toContain('boom')
    expect(warnings.join(' ')).toContain('repo')
  })
})