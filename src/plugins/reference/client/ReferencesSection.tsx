/**
 * References settings section: the alias → external-directory reference table
 * (the `dsh-reference` settings namespace) as a CRUD list. Each row shows the
 * alias, identity (local path or git repository URL + branch/refresh markers),
 * description, an auto-include toggle (system-prompt advertisement; off keeps
 * the entry @-mountable), a ⚠ marker for local paths
 * that do not exist on the host (git entries probe nothing — their cache lands
 * asynchronously), and edit/delete actions; edits happen inline, additions open
 * a modal. The type toggle switches the form between the local shape (path +
 * Choose folder) and the git shape (repository URL + optional branch + the
 * always-refresh override); saving validates through the shared pure core
 * (alias/path rules plus the XOR `entryShapeError`) and probes host existence
 * for local paths — a missing directory only warns, never blocks (US-6/US-7).
 * The table snapshot rides the injected settings scope, bound by the renderer
 * as `useSettings`: a host document commit lands in this list without a reload.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button, Modal, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ReferenceEntry, ReferenceTable } from '../pure.ts'
import { aliasValidationError, branchValidationError, entryShapeError, referencePathError } from '../pure.ts'
import css from './ReferencesSection.module.css'

/** Registration-side face used by the page. */
export interface ReferencesSectionInjected {
  hooks: {
    /** Bound `dsh-reference` settings scope; the renderer binds it as `useSettings`. */
    settings: SettingsScope<ReferenceTable>
  }
  /**
   * Persist one entry. A rename unsets the previous alias first and then writes
   * the new one, so a partial failure never leaves two keys.
   * @param alias - the entry key to write.
   * @param entry - the entry value.
   * @param previousAlias - the previous key when renaming, undefined for a new entry.
   */
  saveEntry: (alias: string, entry: ReferenceEntry, previousAlias?: string) => Promise<void>
  /**
   * Remove one entry.
   * @param alias - the entry key to remove.
   */
  removeEntry: (alias: string) => Promise<void>
  /**
   * Probe whether one raw path exists on the host. A failed probe answers true
   * so an unreachable host never fabricates warnings.
   * @param rawPath - the raw path as stored (may start with `~/`).
   * @returns true when the resolved path exists.
   */
  probePath: (rawPath: string) => Promise<boolean>
  /**
   * Spawn the host's native folder dialog. Cancel or failure answers
   * `{ canceled: true }`; the manual input path always stays available.
   */
  pickDirectory: () => Promise<{ canceled: boolean; path?: string }>
}

/** Full component props assembled by the Settings slot renderer. */
export type ReferencesSectionProps = PropsRuntime<'settings.section'>
  & PropsLocale<'settings.references'>
  & InjectFace<ReferencesSectionInjected>

/** One editable entry draft: either kind, with both shapes' fields kept. */
interface Draft {
  alias: string
  kind: 'local' | 'git'
  path: string
  repository: string
  branch: string
  description: string
  /** System-prompt advertisement (default on). Off = the entry stays @-mountable but the agent is not told. */
  autoInclude: boolean
  /** Git-only: per-entry refresh override (`always`; default follows the global Config). */
  alwaysRefresh: boolean
}

/** Draft validation feedback, keyed by field. */
type DraftErrors = Partial<Record<'alias' | 'path' | 'repository' | 'branch', string>>

/** Which editing surface is open: none, one row in place, or the add modal. */
type Editing =
  | { mode: 'idle' }
  | { mode: 'row'; alias: string; draft: Draft; errors: DraftErrors }
  | { mode: 'add'; draft: Draft; errors: DraftErrors }

const EMPTY_DRAFT: Draft = {
  alias: '',
  kind: 'local',
  path: '',
  repository: '',
  branch: '',
  description: '',
  autoInclude: true,
  alwaysRefresh: false,
}

/**
 * Validate a draft against the shared pure core; a legal draft returns an
 * empty error map. The alias-exists collision is a page concern, not a pure
 * rule, so it is evaluated here against the live table. Git drafts validate
 * through the XOR shape rule (`entryShapeError`): the error is attributed to
 * the field that owns it (branch characters → branch, otherwise → repository).
 * @param draft - the draft to validate.
 * @param alreadyTaken - whether the draft alias collides with another entry.
 * @param t - the page dictionary.
 * @returns the field errors (possibly empty).
 */
function draftErrors(draft: Draft, alreadyTaken: boolean, t: ReferencesSectionProps['t']): DraftErrors {
  const errors: DraftErrors = {}
  const alias = aliasValidationError(draft.alias)
  if (alias !== undefined) errors.alias = alias
  else if (alreadyTaken) errors.alias = t('aliasExists')
  if (draft.kind === 'local') {
    const path = referencePathError(draft.path)
    if (path !== undefined) errors.path = path
  } else {
    const shape = entryShapeError({
      repository: draft.repository.trim(),
      ...(draft.branch.trim() === '' ? {} : { branch: draft.branch.trim() }),
    })
    if (shape !== undefined) {
      if (draft.branch.trim() !== '' && branchValidationError(draft.branch.trim()) !== undefined) {
        errors.branch = shape
      } else {
        errors.repository = shape
      }
    }
  }
  return errors
}

/** Build the stored entry value from a draft (empty optional fields are omitted). */
function entryOf(draft: Draft): ReferenceEntry {
  const description = draft.description.trim() === '' ? undefined : draft.description.trim()
  if (draft.kind === 'git') {
    const branch = draft.branch.trim()
    return {
      repository: draft.repository.trim(),
      ...(branch === '' ? {} : { branch }),
      ...(draft.alwaysRefresh ? { refresh: 'always' as const } : {}),
      ...(description === undefined ? {} : { description }),
      autoInclude: draft.autoInclude,
    }
  }
  return {
    path: draft.path.trim(),
    ...(description === undefined ? {} : { description }),
    autoInclude: draft.autoInclude,
  }
}

/**
 * Render the References settings page.
 * @param props - composed slot props (see {@link ReferencesSectionProps}).
 * @returns the settings page element tree.
 */
export function ReferencesSection(props: ReferencesSectionProps): ReactNode {
  const { t, useSettings, saveEntry, removeEntry, probePath, pickDirectory } = props
  const snapshot = useSettings(state => state)
  const [editing, setEditing] = useState<Editing>({ mode: 'idle' })
  const [warnings, setWarnings] = useState<Record<string, boolean>>({})
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)
  const [pickingPath, setPickingPath] = useState(false)

  const rows = useMemo(() => {
    const table = snapshot.value ?? {}
    return Object.keys(table).sort().map(alias => ({ alias, entry: table[alias] }))
  }, [snapshot.value])

  // Probe each loaded row once after its first appearance; a later save
  // re-probes that alias and replaces the answer. Git entries carry no local
  // path to probe (their cache lands asynchronously) — skipped (v2 client UI
  // owns their surface). Component-internal behavior over injected callbacks
  // only — no external subscription here.
  useEffect(() => {
    if (snapshot.status !== 'ready') return
    let cancelled = false
    for (const { alias, entry } of rows) {
      if (alias in warnings) continue
      if (entry.path === undefined) continue
      void probePath(entry.path).then((exists) => {
        if (cancelled) return
        setWarnings(prev => (prev[alias] === exists ? prev : { ...prev, [alias]: exists }))
      })
    }
    return () => { cancelled = true }
  }, [snapshot.status, rows, probePath, warnings])

  /** Validate, probe, and persist one draft (add or row-edit). */
  const saveDraft = async (draft: Draft, previousAlias: string | undefined): Promise<void> => {
    const table = snapshot.value ?? {}
    const alreadyTaken = previousAlias === undefined
      ? draft.alias in table
      : previousAlias !== draft.alias && draft.alias in table
    const errors = draftErrors(draft, alreadyTaken, t)
    if (errors.alias !== undefined || errors.path !== undefined || errors.repository !== undefined || errors.branch !== undefined) {
      setEditing(previousAlias === undefined
        ? { mode: 'add', draft, errors }
        : { mode: 'row', alias: previousAlias, draft, errors })
      return
    }
    const entry = entryOf(draft)
    // Local drafts probe host existence for the ⚠ marker; git drafts skip the
    // probe (their cache materializes asynchronously) and record no warning.
    const exists = draft.kind === 'local' ? await probePath(draft.path) : undefined
    try {
      await saveEntry(draft.alias, entry, previousAlias)
    } catch (reason) {
      console.warn('dsh-reference: save rejected:', reason)
      return
    }
    setWarnings(prev => {
      const next = { ...prev }
      if (previousAlias !== undefined && previousAlias !== draft.alias) delete next[previousAlias]
      if (exists !== undefined) next[draft.alias] = exists
      return next
    })
    setConfirmingDelete(null)
    setEditing({ mode: 'idle' })
  }

  /** Persist the row's auto-include toggle without leaving the list. */
  const toggleAutoInclude = (alias: string, entry: ReferenceEntry): void => {
    void saveEntry(alias, { ...entry, autoInclude: !entry.autoInclude }).catch((reason: unknown) => {
      console.warn('dsh-reference: auto-include toggle rejected:', reason)
    })
  }

  /** Delete one entry (already confirmed by the row's two-step action). */
  const remove = (alias: string): void => {
    setConfirmingDelete(null)
    setWarnings(prev => {
      const next = { ...prev }
      delete next[alias]
      return next
    })
    void removeEntry(alias).catch((reason: unknown) => {
      console.warn('dsh-reference: delete rejected:', reason)
    })
  }

  const openEdit = (alias: string, entry: ReferenceEntry): void => {
    const git = entry.repository !== undefined
    setEditing({
      mode: 'row',
      alias,
      draft: {
        alias,
        kind: git ? 'git' : 'local',
        path: entry.path ?? '',
        repository: entry.repository ?? '',
        branch: entry.branch ?? '',
        description: entry.description ?? '',
        autoInclude: entry.autoInclude,
        alwaysRefresh: entry.refresh === 'always',
      },
      errors: {},
    })
  }

  /** Fill the path field from the host's native folder dialog; cancel or failure keep the manual value. */
  const pickPath = async (draft: Draft, onChange: (draft: Draft) => void): Promise<void> => {
    setPickingPath(true)
    try {
      const picked = await pickDirectory()
      if (!picked.canceled && picked.path !== undefined) onChange({ ...draft, path: picked.path })
    } finally {
      setPickingPath(false)
    }
  }

  /** The shared field form: type toggle, shape fields per kind, auto-include, git refresh override, errors. */
  const renderForm = (
    draft: Draft,
    errors: DraftErrors,
    onChange: (draft: Draft) => void,
  ): ReactNode => (
    <div className={css.form}>
      <div className={css.typeRow} role="group" aria-label={t('type')}>
        <label className={css.typeOption} data-selected={draft.kind === 'local'}>
          <input
            type="radio"
            name="reference-kind"
            checked={draft.kind === 'local'}
            onChange={() => { onChange({ ...draft, kind: 'local' }) }}
          />
          <span>{t('type.local')}</span>
        </label>
        <label className={css.typeOption} data-selected={draft.kind === 'git'}>
          <input
            type="radio"
            name="reference-kind"
            checked={draft.kind === 'git'}
            onChange={() => { onChange({ ...draft, kind: 'git' }) }}
          />
          <span>{t('type.git')}</span>
        </label>
      </div>
      <label className={css.field}>
        <span>{t('alias')}</span>
        <input
          value={draft.alias}
          placeholder={t('aliasPlaceholder')}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => { onChange({ ...draft, alias: event.currentTarget.value }) }}
        />
        {errors.alias !== undefined && <span className={css.error}>{errors.alias}</span>}
      </label>
      {draft.kind === 'local' ? (
        <label className={css.field}>
          <span>{t('path')}</span>
          <div className={css.pathRow}>
            <input
              className={css.pathInput}
              value={draft.path}
              placeholder={t('pathPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => { onChange({ ...draft, path: event.currentTarget.value }) }}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={pickingPath}
              onClick={() => { void pickPath(draft, onChange) }}
            >
              {t('pickDirectory')}
            </Button>
          </div>
          {errors.path !== undefined && <span className={css.error}>{errors.path}</span>}
        </label>
      ) : (
        <>
          <label className={css.field}>
            <span>{t('repository')}</span>
            <input
              value={draft.repository}
              placeholder={t('repositoryPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => { onChange({ ...draft, repository: event.currentTarget.value }) }}
            />
            {errors.repository !== undefined && <span className={css.error}>{errors.repository}</span>}
          </label>
          <label className={css.field}>
            <span>{t('branch')}</span>
            <input
              value={draft.branch}
              placeholder={t('branchPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => { onChange({ ...draft, branch: event.currentTarget.value }) }}
            />
            {errors.branch !== undefined && <span className={css.error}>{errors.branch}</span>}
          </label>
        </>
      )}
      <label className={css.field}>
        <span>{t('description')}</span>
        <input
          value={draft.description}
          placeholder={t('descriptionPlaceholder')}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => { onChange({ ...draft, description: event.currentTarget.value }) }}
        />
      </label>
      <Switch
        label={t('autoInclude')}
        checked={draft.autoInclude}
        title={t('autoIncludeHint')}
        onChange={(next) => { onChange({ ...draft, autoInclude: next }) }}
      />
      <p className={css.formHint}>{t('autoIncludeHint')}</p>
      {draft.kind === 'git' && (
        <>
          <Switch
            label={t('alwaysRefresh')}
            checked={draft.alwaysRefresh}
            onChange={(next) => { onChange({ ...draft, alwaysRefresh: next }) }}
          />
          <p className={css.formHint}>{t('alwaysRefreshHint')}</p>
        </>
      )}
    </div>
  )

  if (snapshot.status === 'loading') {
    return <p className={css.status}>{t('loading')}</p>
  }
  if (snapshot.status === 'unavailable') {
    return <p className={css.status}>{t('unavailable')}</p>
  }

  return (
    <div className={css.section}>
      <p className={css.intro}>{t('intro')}</p>
      {rows.length === 0 ? <p className={css.status}>{t('empty')}</p> : null}
      <ul className={css.rows}>
        {rows.map(({ alias, entry }) => (
          <li key={alias} className={css.rowCard}>
            <div className={css.rowMain}>
              <div className={css.rowIdentity}>
                <span className={css.rowAlias}>{alias}</span>
                {entry.repository !== undefined ? (
                  <span className={css.rowPath}>{entry.repository}</span>
                ) : (
                  <span className={css.rowPath}>{entry.path}</span>
                )}
                {(entry.branch !== undefined || entry.refresh === 'always') && (
                  <span className={css.rowDesc}>
                    {entry.branch !== undefined ? `branch: ${entry.branch}` : ''}
                    {entry.refresh === 'always' ? (entry.branch !== undefined ? ' · ' : '') + t('alwaysRefresh') : ''}
                  </span>
                )}
                {entry.description !== undefined && <span className={css.rowDesc}>{entry.description}</span>}
              </div>
              <div className={css.rowControls}>
                {warnings[alias] === false && (
                  <span className={css.warn} role="img" aria-label={t('warn')} title={t('warn')}>⚠ {t('warn')}</span>
                )}
                <Switch
                  label={t('autoInclude')}
                  checked={entry.autoInclude}
                  title={t('autoIncludeHint')}
                  onChange={() => { toggleAutoInclude(alias, entry) }}
                />
              </div>
            </div>
            <div className={css.rowActions}>
              <Button variant="ghost" size="sm" onClick={() => { openEdit(alias, entry) }}>{t('edit')}</Button>
              {confirmingDelete === alias ? (
                <Button variant="outline" size="sm" onClick={() => { remove(alias) }}>{t('confirm')}</Button>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => { setConfirmingDelete(alias) }}>{t('delete')}</Button>
              )}
            </div>
            {editing.mode === 'row' && editing.alias === alias && (
              <div className={css.inlineEdit}>
                {renderForm(editing.draft, editing.errors, draft => { setEditing({ ...editing, draft }) })}
                <div className={css.formActions}>
                  <Button variant="ghost" size="sm" onClick={() => { setEditing({ mode: 'idle' }) }}>{t('cancel')}</Button>
                  <Button variant="primary" size="sm" onClick={() => { void saveDraft(editing.draft, editing.alias) }}>{t('save')}</Button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className={css.rowActions}>
        <Button variant="outline" size="sm" onClick={() => { setEditing({ mode: 'add', draft: EMPTY_DRAFT, errors: {} }) }}>{t('add')}</Button>
      </div>
      {editing.mode === 'add' && (
        <Modal
          open
          title={t('addModalTitle')}
          closeLabel={t('close')}
          onClose={() => { setEditing({ mode: 'idle' }) }}
          footer={(
            <div className={css.formActions}>
              <Button variant="ghost" size="sm" onClick={() => { setEditing({ mode: 'idle' }) }}>{t('cancel')}</Button>
              <Button variant="primary" size="sm" onClick={() => { void saveDraft(editing.draft, undefined) }}>{t('save')}</Button>
            </div>
          )}
        >
          {renderForm(editing.draft, editing.errors, draft => { setEditing({ ...editing, draft }) })}
        </Modal>
      )}
    </div>
  )
}