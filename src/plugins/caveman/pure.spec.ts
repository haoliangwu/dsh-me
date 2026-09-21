import { describe, expect, it } from 'vitest'
import {
  CAVEMAN_BANNER,
  CAVEMAN_LEVELS,
  buildInjection,
  classifyCommand,
  filterRuleset,
  isCavemanLevel,
  parseLevel,
  resolveLevelOf,
  resolveSkillPath,
  stripFrontmatter,
} from './pure.ts'

describe('level vocabulary', () => {
  it('contains the seven legal levels', () => {
    expect(CAVEMAN_LEVELS).toEqual(['lite', 'full', 'ultra', 'wenyan-lite', 'wenyan-full', 'wenyan-ultra', 'off'])
  })

  it('accepts exactly the legal levels', () => {
    for (const level of CAVEMAN_LEVELS) expect(isCavemanLevel(level)).toBe(true)
    expect(isCavemanLevel('medium')).toBe(false)
    expect(isCavemanLevel('')).toBe(false)
    expect(isCavemanLevel(undefined)).toBe(false)
    expect(isCavemanLevel(7)).toBe(false)
  })

  it('parses trimmed values and rejects garbage', () => {
    expect(parseLevel(' full ')).toBe('full')
    expect(parseLevel(undefined)).toBeUndefined()
    expect(parseLevel('')).toBeUndefined()
    expect(parseLevel('tl;dr')).toBeUndefined()
  })
})

describe('resolveLevelOf (flag > default)', () => {
  it('uses a legal flag content', () => {
    expect(resolveLevelOf('full', 'lite')).toBe('full')
    expect(resolveLevelOf('off', 'lite')).toBe('off')
  })

  it('falls back to the default for missing or invalid flag content', () => {
    expect(resolveLevelOf(undefined, 'lite')).toBe('lite')
    expect(resolveLevelOf('  ', 'lite')).toBe('lite')
    expect(resolveLevelOf('garbage', 'lite')).toBe('lite')
    expect(resolveLevelOf(undefined, 'full')).toBe('full')
  })
})

describe('stripFrontmatter', () => {
  it('strips a YAML frontmatter block', () => {
    expect(stripFrontmatter('---\ntitle: caveman\n---\n# Rules\nbody')).toBe('# Rules\nbody')
  })

  it('preserves text without a frontmatter opener', () => {
    expect(stripFrontmatter('# Rules\nbody')).toBe('# Rules\nbody')
    expect(stripFrontmatter('')).toBe('')
  })

  it('swallows an unclosed frontmatter block', () => {
    expect(stripFrontmatter('---\ntitle: lost')).toBe('')
  })
})

describe('filterRuleset (per-level retention)', () => {
  const skill = [
    '# Caveman skill',
    '',
    '| Level | Meaning |',
    '|---|---|',
    '| **lite** | lite row |',
    '| **full** | full row |',
    '| **ultra** | ultra row |',
    '',
    '- full: an example line',
    '- lite: another example',
    '',
    '### Persistence (shared section)',
    'Shared text stays across levels.',
  ].join('\n')

  it('keeps only the active level table rows and examples', () => {
    const full = filterRuleset(skill, 'full')
    expect(full).toContain('| **full** | full row |')
    expect(full).not.toContain('| **lite** | lite row |')
    expect(full).not.toContain('| **ultra** | ultra row |')
    expect(full).toContain('- full: an example line')
    expect(full).not.toContain('- lite: another example')
  })

  it('keeps header, separator, and shared text at every level', () => {
    const lite = filterRuleset(skill, 'lite')
    expect(lite).toContain('| Level | Meaning |')
    expect(lite).toContain('|---|---|')
    expect(lite).toContain('### Persistence (shared section)')
    expect(lite).toContain('Shared text stays across levels.')
    expect(lite).toContain('| **lite** | lite row |')
    expect(lite).not.toContain('| **full** | full row |')
  })

  it('keeps wenyan-family rows under their own levels', () => {
    const wenyan = filterRuleset(skill.replace('| **ultra** | ultra row |', '| **wenyan-ultra** | wenyan row |'), 'wenyan-ultra')
    expect(wenyan).toContain('| **wenyan-ultra** | wenyan row |')
  })

  it('returns empty for an empty body', () => {
    expect(filterRuleset('', 'lite')).toBe('')
  })
})

describe('buildInjection', () => {
  it('emits the verbatim banner plus the filtered body', () => {
    const injected = buildInjection('full', '| **full** | row |\n| **lite** | lite |\nshared')
    expect(injected).toBe(`${CAVEMAN_BANNER('full')}\n\n| **full** | row |\nshared`)
    expect(CAVEMAN_BANNER('lite')).toBe('CAVEMAN MODE ACTIVE (lite) — session ruleset applies.')
  })
})

describe('resolveSkillPath (progressive resolution)', () => {
  const globalPath = '/home/u/.agents/skills/caveman/SKILL.md'
  const exists = (needle: string) => (hay: string): boolean => hay === needle

  it('prefers the project-local copy under the session cwd', () => {
    const probe = exists('/work/a/.agents/skills/caveman/SKILL.md')
    expect(resolveSkillPath('/work/a', probe, globalPath))
      .toBe('/work/a/.agents/skills/caveman/SKILL.md')
  })

  it('falls back to the global copy when the project copy is absent', () => {
    const probe = exists(globalPath)
    expect(resolveSkillPath('/work/a', probe, globalPath)).toBe(globalPath)
  })

  it('returns undefined when neither copy exists', () => {
    const probe = (): boolean => false
    expect(resolveSkillPath('/work/a', probe, globalPath)).toBeUndefined()
  })

  it('tries only the global copy without a cwd', () => {
    expect(resolveSkillPath(undefined, exists(globalPath), globalPath)).toBe(globalPath)
    expect(resolveSkillPath(undefined, (): boolean => false, globalPath)).toBeUndefined()
  })
})

describe('classifyCommand', () => {
  it('empty input is a status request', () => {
    expect(classifyCommand('')).toEqual({ kind: 'status' })
    expect(classifyCommand('   ')).toEqual({ kind: 'status' })
  })

  it('a legal level is a set request (off is first-class)', () => {
    expect(classifyCommand('lite')).toEqual({ kind: 'set', level: 'lite' })
    expect(classifyCommand(' off ')).toEqual({ kind: 'set', level: 'off' })
    expect(classifyCommand('wenyan-full')).toEqual({ kind: 'set', level: 'wenyan-full' })
  })

  it('an illegal level is invalid with the vocabulary listed', () => {
    const request = classifyCommand('medium')
    expect(request.kind).toBe('invalid')
    if (request.kind === 'invalid') {
      expect(request.text).toContain('medium')
      for (const level of CAVEMAN_LEVELS) expect(request.text).toContain(level)
    }
  })
})