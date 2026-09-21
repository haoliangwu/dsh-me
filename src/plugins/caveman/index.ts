/**
 * dsh-caveman, node half.
 *
 * Global caveman communication level for every dsh assembly: the level's
 * source of truth is the atomic-write flag file `~/.dsh/.caveman-active`
 * (falling back to `defaultLevel` only when absent/invalid), and a dynamic
 * `systemPrompt` section re-reads the flag plus the level-filtered SKILL.md
 * at every assembly (order 10300, after persona suffixes — override-style
 * directives go last). `off` is a first-class level that empties the
 * section; an unreadable SKILL.md empties it too. `/caveman` switches and
 * persists the level (`off` = write the literal level), shows status with no
 * argument, and errors with the legal vocabulary for illegal input.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  CAVEMAN_LEVELS,
  DEFAULT_LEVEL,
  buildInjection,
  classifyCommand,
  resolveLevelOf,
  resolveSkillPath,
  stripFrontmatter,
  type CavemanLevel,
} from './pure.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-caveman'

/** Required services: the system-prompt registry and the command registry. */
export const inject = ['systemPrompt', 'commands']

/** Plugin config: the fallback level used while no flag file exists. */
export interface Config {
  defaultLevel?: CavemanLevel
}

export const Config = z.object({
  defaultLevel: z.union(CAVEMAN_LEVELS as const).default(DEFAULT_LEVEL),
})

/** Flag file location (spec): `~/.dsh/.caveman-active`. */
export const FLAG_RELATIVE = '.dsh/.caveman-active'

/** Section placement: after the persona suffix, the tail override slot. */
export const SECTION_NAME = 'dsh-caveman:rules'
export const SECTION_ORDER = 10300

/** Structural assembly context: the harness type only declares scope/signal, but the runtime carries the agent (agent-loop reads context.agent as well). */
interface AssemblyContextLike {
  readonly agent?: { readonly session?: { readonly header?: { readonly cwd?: string } } }
}

/** Structural system-prompt service face. */
interface SystemPromptLike {
  section(section: {
    readonly name: string
    readonly order: number
    readonly text: (context: AssemblyContextLike) => string
    /** False preserves literal text (no {{variable}} interpolation — renderPrompt would throw on unknown names). */
    readonly interpolate?: boolean
  }): () => void
}

/** Structural command-registry face. */
interface CommandRegistrarLike {
  register(definition: unknown): () => void
}

/** Structural plugin context face. */
interface CavemanCtx {
  systemPrompt: SystemPromptLike
  commands: CommandRegistrarLike
  emit(event: 'system-prompt/change'): void
}

/** The effective level from the flag file, falling back to the config default when absent/invalid. */
function readFlagLevel(flagPath: string, config: Config): CavemanLevel {
  let content: string | undefined
  try {
    content = readFileSync(flagPath, 'utf8')
  } catch {
    content = undefined // absent flag = reset to default
  }
  return resolveLevelOf(content, config.defaultLevel ?? DEFAULT_LEVEL)
}

/** The resolved SKILL.md text, or undefined when neither the project nor the global copy exists. */
function readSkillBody(cwd: string | undefined, globalSkillPath: string): string | undefined {
  const path = resolveSkillPath(cwd, candidate => existsSync(candidate), globalSkillPath)
  if (path === undefined) return undefined
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** Atomic flag write: temp file + rename within the same directory (spec decision 9). */
function atomicWriteFlag(flagPath: string, content: string): void {
  mkdirSync(dirname(flagPath), { recursive: true })
  const temporary = `${flagPath}.${String(process.pid)}.${Date.now().toString(36)}.tmp`
  try {
    writeFileSync(temporary, content, 'utf8')
    renameSync(temporary, flagPath)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

/**
 * Mount the dynamic prompt section and the `/caveman` command.
 * @param ctx - host plugin context.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const scoped = ctx as unknown as CavemanCtx
  const flagPath = join(homedir(), FLAG_RELATIVE)
  const globalSkillPath = join(homedir(), '.agents', 'skills', 'caveman', 'SKILL.md')

  // Read fresh at every assembly: multi-host parity, SKILL.md edits land next
  // turn, and a host restart never serves a stale process-local level.
  ctx.effect(() => scoped.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    // Preserve the ruleset verbatim: this is model-facing instruction text,
    // not a prompt-variable template — a literal {{...}} in SKILL.md would
    // otherwise throw at render (strict unknown-variable interpolation).
    interpolate: false,
    text: (assembly) => {
      const level = readFlagLevel(flagPath, config)
      if (level === 'off') return ''
      const cwd = (assembly as unknown as AssemblyContextLike).agent?.session?.header?.cwd
      const body = readSkillBody(cwd, globalSkillPath)
      if (body === undefined) return ''
      return buildInjection(level, stripFrontmatter(body))
    },
  }))

  scoped.commands.register({
    name: 'caveman',
    description: 'Set or show the global caveman communication level (persisted in ~/.dsh/.caveman-active)',
    input: { hint: CAVEMAN_LEVELS.join('|') },
    async handler(invocation: { rawInput: string; agent?: { session?: { header?: { cwd?: string } } } }) {
      const request = classifyCommand(invocation.rawInput)
      switch (request.kind) {
        case 'status': {
          const level = readFlagLevel(flagPath, config)
          const cwd = invocation.agent?.session?.header?.cwd
          const skillPath = resolveSkillPath(cwd, candidate => existsSync(candidate), globalSkillPath)
          return {
            kind: 'success',
            text: `CAVEMAN level: ${level} (flag: ${flagPath}; SKILL.md: ${skillPath ?? '(none)'}; levels: ${CAVEMAN_LEVELS.join(', ')})`,
          }
        }
        case 'set': {
          atomicWriteFlag(flagPath, request.level)
          // Invalidate any assembly-cached prompt state so later assemblies
          // pick the new level without a restart (spec decision 3).
          scoped.emit('system-prompt/change')
          return { kind: 'success', text: `CAVEMAN level set to ${request.level} (persisted)` }
        }
        case 'invalid':
          return { kind: 'error', text: request.text }
      }
    },
  })
}