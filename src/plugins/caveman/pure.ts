/**
 * dsh-caveman pure decision core: level vocabulary, command-input
 * classification, SKILL.md frontmatter stripping, per-level ruleset
 * filtering, banner assembly, and cwd-first skill-path resolution. Zero I/O
 * — filesystem dependencies (existence, content) are injected, so vitest
 * covers every branch without harness fixtures.
 */

/** Legal caveman levels, also the vocabulary for `/caveman` arguments. */
export const CAVEMAN_LEVELS = ['lite', 'full', 'ultra', 'wenyan-lite', 'wenyan-full', 'wenyan-ultra', 'off'] as const

/** The level vocabulary union. */
export type CavemanLevel = (typeof CAVEMAN_LEVELS)[number]

/** Fallback level when no flag file exists (schema default; spec US-9). */
export const DEFAULT_LEVEL: CavemanLevel = 'lite'

/** Whether one value is a legal level token. */
export function isCavemanLevel(value: unknown): value is CavemanLevel {
  return typeof value === 'string' && (CAVEMAN_LEVELS as readonly string[]).includes(value)
}

/** Parse a raw flag/content string into a level; undefined for absent or invalid input. */
export function parseLevel(value: string | undefined): CavemanLevel | undefined {
  return value !== undefined && isCavemanLevel(value.trim()) ? value.trim() : undefined
}

/**
 * Resolve the effective level: the flag file content wins when readable and
 * legal; anything else falls back to the configured default (spec decision 2
 * — only a missing/invalid flag falls back; user deletion resets to default).
 * @param flagContent - the flag file's raw content, or undefined when unreadable/absent.
 * @param defaultLevel - the plugin's configured default.
 * @returns the effective level.
 */
export function resolveLevelOf(flagContent: string | undefined, defaultLevel: CavemanLevel): CavemanLevel {
  return parseLevel(flagContent) ?? defaultLevel
}

/**
 * Strip a YAML frontmatter block bounded by `---` lines. Text without a
 * leading `---` line passes through; an unclosed block swallows everything.
 * @param text - the raw SKILL.md text.
 * @returns the body after the frontmatter, or the full text.
 */
export function stripFrontmatter(text: string): string {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return text
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === '---') return lines.slice(index + 1).join('\n')
  }
  return ''
}

/** The intensity-level tokens that appear inside leveled rows (off is not an intensity). */
const LEVELED_TOKENS = CAVEMAN_LEVELS.filter(token => token !== 'off').join('|')

/** Table-row matcher: `| **<level>** |` — matched once at module scope. */
const LEVELED_TABLE_ROW = new RegExp(`^\\|\\s*\\*\\*(${LEVELED_TOKENS})\\*\\*\\s*\\|`)

/** Example-line matcher: `- <level>:` — matched once at module scope. */
const LEVELED_EXAMPLE = new RegExp(`^\\s*-\\s*(${LEVELED_TOKENS}):`)

/**
 * Filter one SKILL.md body to the current level: `| **level** |` table rows
 * and `- level:` example lines keep only the rows of the active level; every
 * other line (shared sections, table headers, separator rows, prose) passes
 * through untouched.
 * @param skillBody - the SKILL.md body (frontmatter already stripped).
 * @param level - the active level.
 * @returns the filtered body.
 */
export function filterRuleset(skillBody: string, level: CavemanLevel): string {
  return skillBody
    .split('\n')
    .filter(line => {
      const table = line.match(LEVELED_TABLE_ROW)
      if (table !== null) return table[1] === level
      const sample = line.match(LEVELED_EXAMPLE)
      if (sample !== null) return sample[1] === level
      return true
    })
    .join('\n')
}

/** The banner line, verbatim per spec. */
export const CAVEMAN_BANNER = (level: CavemanLevel): string =>
  `CAVEMAN MODE ACTIVE (${level}) — session ruleset applies.`

/**
 * Assemble the injection: the banner plus the level-filtered ruleset body.
 * @param level - the active level.
 * @param skillBody - the SKILL.md body (frontmatter already stripped).
 * @returns the injected text.
 */
export function buildInjection(level: CavemanLevel, skillBody: string): string {
  return `${CAVEMAN_BANNER(level)}\n\n${filterRuleset(skillBody, level).trim()}`
}

/** Project-local skill path relative to a session cwd. */
export const PROJECT_SKILL_RELATIVE = '.agents/skills/caveman/SKILL.md'

/**
 * Progressive skill-path resolution (spec decision 7): the session cwd's
 * project-local copy wins when present; otherwise the global copy; neither →
 * undefined (empty injection). Self-targeting is allowed — every assembly
 * participates.
 * @param cwd - the assembling session's cwd, or undefined when absent.
 * @param exists - injected filesystem existence probe.
 * @param globalSkillPath - the global `~/.agents/skills/caveman/SKILL.md`.
 * @returns the chosen path, or undefined.
 */
export function resolveSkillPath(
  cwd: string | undefined,
  exists: (path: string) => boolean,
  globalSkillPath: string,
): string | undefined {
  if (cwd !== undefined) {
    const projectPath = `${cwd}/${PROJECT_SKILL_RELATIVE}`
    if (exists(projectPath)) return projectPath
  }
  return exists(globalSkillPath) ? globalSkillPath : undefined
}

/** One `/caveman` request classification. */
export type CavemanCommandRequest =
  | { readonly kind: 'status' }
  | { readonly kind: 'set'; readonly level: CavemanLevel }
  | { readonly kind: 'invalid'; readonly text: string }

/**
 * Classify the command's trimmed raw arguments: empty → status display; a
 * legal level → set (off is a first-class level, persisted, not deletion);
 * anything else → invalid with the legal vocabulary listed.
 * @param rawArgs - the command invocation's raw input.
 * @returns the request classification.
 */
export function classifyCommand(rawArgs: string): CavemanCommandRequest {
  const args = rawArgs.trim()
  if (args === '') return { kind: 'status' }
  const level = parseLevel(args)
  if (level !== undefined) return { kind: 'set', level }
  return {
    kind: 'invalid',
    text: `未识别的档位「${args}」；合法档位：${CAVEMAN_LEVELS.join('、')}`,
  }
}