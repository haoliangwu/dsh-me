/**
 * dsh-reference, browser half: the References settings page (`settings.section`
 * entry, order 30) and the `@`-menu source mounting external-directory
 * references as plain-text `@<path>` mentions. Both halves share one bound
 * `dsh-reference` settings scope: the page subscribes through its injected
 * hook (host document commits land in the list without a reload), while the
 * trigger source re-reads the same snapshot at every menu open — settings
 * edits are visible in `@` immediately. Hidden entries are clipped by the
 * shared pure core; saving validates through the same alias/path rules; the
 * mention serialization is the shared `serializeMention` (space-containing
 * paths take the quoted form). Export discipline: packages/client/AGENTS.md.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ui-settings SlotMap + settingsScope Context merges.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the ui-input-trigger Context merge + source contract.
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
// Type-only: pulls the ctx.remote merge (fixed Host facts; the read-only
// settings describe mirror lives with ui-settings, which supplies ctx.settingsScope).
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the ctx.slots merge (the slot registry service face).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the browser Connection handle face for the host path-existence probe.
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { InputTriggerServiceContract, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { ReferenceEntry } from '../pure.ts'
import { candidateEntries, normalizeTable, resolveReferencePath, serializeMention } from '../pure.ts'
import { ReferencesSection } from './ReferencesSection.tsx'
import type { ReferencesSectionInjected } from './ReferencesSection.tsx'
import { en, zh, type ReferenceKey } from './locales.ts'

export type { ReferencesSectionInjected, ReferencesSectionProps } from './ReferencesSection.tsx'
export type { ReferenceKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The dsh-reference settings page + @-menu copy. */
    'settings.references': ReferenceKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.references'

/** Settings namespace registered by the host half (settings.yaml persisted). */
const SETTINGS_NS = 'dsh-reference'

/**
 * The single registration identity of the `@` source. The service enforces
 * (trigger, name) uniqueness; more importantly, the submit pipeline routes a
 * chip's serialization back through the controller by EXACTLY this name
 * (`serializeReference(source, ref)` → roster.find(s => s.name === source)),
 * so the trigger source's `name`, every inserted reference's `source` field,
 * and this constant must always be one string. See ui-conversation
 * input/facade.ts sinkSerialized + ui-input-trigger controller.
 */
export const SOURCE_NAME = 'dsh-reference'

/** RPC channel owned by the host half of this plugin. */
const CHANNEL = '/dsh-reference'

/** Endpoint under {@link CHANNEL} probing one path's existence on the host. */
const ENDPOINT_EXISTS = 'exists'

/** Endpoint under {@link CHANNEL} spawning the host's native folder dialog. */
const ENDPOINT_PICK_DIRECTORY = 'pickDirectory'

/** Host picker answer (mirror of the host's {@link pickDirectoryOnHost} shape). */
interface PickDirectoryResult {
  readonly canceled: boolean
  readonly path?: string
}

/** Required services: the slot registry, the settings scope, the locale, the trigger pipeline, the Remote facts, and the RPC carrier. */
export const inject = ['slots', 'locale', 'settingsScope', 'inputTriggers', 'remote', 'connection']

/**
 * Client plugin body: register the `settings.references` dictionaries, bind
 * the `dsh-reference` settings scope, contribute the References settings page,
 * and register the `@` trigger source.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-reference: dictionaries')

  const t = ctx.locale.bind(NS)
  // One bound scope for the whole plugin: the page's injected hook and the @
  // source's per-open snapshot reads derive from the same mirror, so they can
  // never disagree about the table.
  const scope = ctx.settingsScope.bind({ namespace: SETTINGS_NS, decode: normalizeTable })
  // Resolved once, where `connection` is declared in this plugin's inject; the
  // browser RPC carrier face is not a Context merge in the published types.
  const connection = ctx.get('connection') as ConnectionHandle

  /** Persist one entry; a rename unsets the previous alias first. */
  const saveEntry = async (alias: string, entry: ReferenceEntry, previousAlias?: string): Promise<void> => {
    if (previousAlias !== undefined && previousAlias !== alias) await scope.unset(previousAlias)
    await scope.set(alias, entry)
  }
  /** Remove one entry. */
  const removeEntry = (alias: string): Promise<void> => scope.unset(alias)
  /** Probe host existence through the RPC channel; a failed or refused probe answers true (no warning). */
  const probePath = (rawPath: string): Promise<boolean> => connection.rpc.call(CHANNEL, ENDPOINT_EXISTS, { path: rawPath })
    .then((result) => {
      const settled = result as RpcResult<{ exists: boolean }>
      if (!settled.ok) {
        console.warn('dsh-reference: existence probe refused:', settled.error)
        return true
      }
      return settled.value.exists
    })
    .catch((reason: unknown) => {
      console.warn('dsh-reference: existence probe failed:', reason)
      return true
    })

  /** Spawn the host's native folder dialog; cancel or failure degrade to no-op. */
  const pickDirectory = async (): Promise<PickDirectoryResult> => {
    const result = await connection.rpc.call(CHANNEL, ENDPOINT_PICK_DIRECTORY, {}) as RpcResult<PickDirectoryResult>
    if (!result.ok) {
      console.warn('dsh-reference: directory picker refused:', result.error)
      return { canceled: true }
    }
    return result.value
  }

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'references',
    // Late nav position: after the pluggable settings sections (models 10,
    // plugins 15, archived-sessions 25).
    order: 30,
    label: () => t('nav'),
    locale: NS,
    inject: (): ReferencesSectionInjected => ({
      hooks: { settings: scope },
      saveEntry,
      removeEntry,
      probePath,
      pickDirectory,
    }),
  }, ReferencesSection))

  const inputTriggers = ctx.get('inputTriggers') as InputTriggerServiceContract
  const source: InputTriggerSource = {
    trigger: '@',
    name: SOURCE_NAME,
    // After the file/session reference group; rows carry their own section
    // label, so the source-title row is suppressed.
    order: 10,
    showGroupTitle: false,
    // Candidates read the live settings snapshot at every menu open; hidden
    // references are clipped by the shared pure core (US-8/US-9).
    async candidates(_session, req) {
      const home = ctx.remote.$host.home
      if (home === undefined) return []
      const table = scope.getSnapshot().value ?? {}
      const query = req.query.trim().toLowerCase()
      return candidateEntries(table, home)
        .filter(candidate =>
          candidate.alias.toLowerCase().includes(query)
          || (candidate.description?.toLowerCase().includes(query) ?? false))
        .map(candidate => ({
          name: candidate.alias,
          description: candidate.description ?? candidate.path,
          icon: 'folder' as const,
          section: t('section.menu'),
          value: candidate.alias,
        }))
    },
    // Settle the picked alias into a plain-text mention (US-10): re-read the
    // snapshot for the freshest path, resolve ~/, and serialize.
    onPick(pick) {
      const home = ctx.remote.$host.home
      const table = scope.getSnapshot().value ?? {}
      const entry = pick.candidate.value === undefined ? undefined : table[pick.candidate.value]
      if (home === undefined || entry === undefined) return undefined
      const mention = serializeMention(resolveReferencePath(entry.path, home))
      return {
        insert: {
          source: SOURCE_NAME,
          ref: mention,
          label: pick.candidate.name,
          appearance: 'folder',
          clipboardText: mention,
        },
      }
    },
    codec: {
      // Both projections are the plain-text mention itself (US-10): the chip
      // clipboard/persistence form and the model form are identical, so the
      // submit pipeline's serialize never fails and never downgrades.
      clipboardText: ref => ref,
      async serialize(ref) {
        return ref
      },
    },
  }
  ctx.effect(() => inputTriggers.registerSource(source), `${SOURCE_NAME}: @ source`)
}