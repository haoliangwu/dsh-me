/**
 * References settings section: the alias → external-directory reference table
 * (the `dsh-reference` settings namespace) as a CRUD list. Each row shows the
 * alias, path, description, a live @-menu visibility toggle, a ⚠ marker for paths that do
 * not exist on the host, and edit/delete actions; edits happen inline, additions
 * open a modal. Saving validates through the shared pure core (alias/path rules)
 * and probes host existence — a missing directory only warns, never blocks
 * (US-6/US-7). The table snapshot rides the injected settings scope, bound by
 * the renderer as `useSettings`: a host document commit lands in this list
 * without a reload.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button, Modal, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ReferenceEntry, ReferenceTable } from '../pure.ts'
import { aliasValidationError, referencePathError } from '../pure.ts'
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

/** One editable entry draft. */
interface Draft {
  alias: string
  path: string
  description: string
  hidden: boolean
}

/** Draft validation feedback, keyed by field. */
type DraftErrors = Partial<Record<'alias' | 'path', string>>

/** Which editing surface is open: none, one row in place, or the add modal. */
type Editing =
  | { mode: 'idle' }
  | { mode: 'row'; alias: string; draft: Draft; errors: DraftErrors }
  | { mode: 'add'; draft: Draft; errors: DraftErrors }

const EMPTY_DRAFT: Draft = { alias: '', path: '', description: '', hidden: false }

/**
 * Validate a draft against the shared pure core; a legal draft returns an
 * empty error map. The alias-exists collision is a page concern, not a pure
 * rule, so it is evaluated here against the live table.
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
  const path = referencePathError(draft.path)
  if (path !== undefined) errors.path = path
  return errors
}

/** Build the stored entry value from a draft (empty description is omitted). */
function entryOf(draft: Draft): ReferenceEntry {
  return {
    path: draft.path.trim(),
    ...(draft.description.trim() === '' ? {} : { description: draft.description.trim() }),
    hidden: draft.hidden,
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
  // re-probes that alias and replaces the answer. Component-internal behavior
  // over injected callbacks only — no external subscription here.
  useEffect(() => {
    if (snapshot.status !== 'ready') return
    let cancelled = false
    for (const { alias, entry } of rows) {
      if (alias in warnings) continue
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
    if (errors.alias !== undefined || errors.path !== undefined) {
      setEditing(previousAlias === undefined
        ? { mode: 'add', draft, errors }
        : { mode: 'row', alias: previousAlias, draft, errors })
      return
    }
    const entry = entryOf(draft)
    const exists = await probePath(draft.path)
    try {
      await saveEntry(draft.alias, entry, previousAlias)
    } catch (reason) {
      console.warn('dsh-reference: save rejected:', reason)
      return
    }
    setWarnings(prev => {
      const next = { ...prev }
      if (previousAlias !== undefined && previousAlias !== draft.alias) delete next[previousAlias]
      next[draft.alias] = exists
      return next
    })
    setConfirmingDelete(null)
    setEditing({ mode: 'idle' })
  }

  /** Persist the row's @-menu visibility toggle without leaving the list. */
  const toggleHidden = (alias: string, entry: ReferenceEntry): void => {
    void saveEntry(alias, { ...entry, hidden: !entry.hidden }).catch((reason: unknown) => {
      console.warn('dsh-reference: hidden toggle rejected:', reason)
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
    setEditing({
      mode: 'row',
      alias,
      draft: { alias, path: entry.path, description: entry.description ?? '', hidden: entry.hidden },
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

  /** The shared field form: type toggle, alias/path/description inputs, @-menu visibility toggle, errors. */
  const renderForm = (
    draft: Draft,
    errors: DraftErrors,
    onChange: (draft: Draft) => void,
  ): ReactNode => (
    <div className={css.form}>
      <div className={css.typeRow} role="group" aria-label={t('type')}>
        <label className={css.typeOption} data-selected>
          <input type="radio" name="reference-kind" checked readOnly />
          <span>{t('type.local')}</span>
        </label>
        <label className={css.typeOption} data-disabled title={t('type.git')}>
          <input type="radio" name="reference-kind" disabled />
          <span>{t('type.git')}</span>
          <span className={css.versionTag}>v2</span>
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
        label={t('menuVisible')}
        checked={!draft.hidden}
        title={t('menuVisibleHint')}
        onChange={(next) => { onChange({ ...draft, hidden: !next }) }}
      />
      <p className={css.formHint}>{t('menuVisibleHint')}</p>
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
                <span className={css.rowPath}>{entry.path}</span>
                {entry.description !== undefined && <span className={css.rowDesc}>{entry.description}</span>}
              </div>
              <div className={css.rowControls}>
                {warnings[alias] === false && (
                  <span className={css.warn} role="img" aria-label={t('warn')} title={t('warn')}>⚠ {t('warn')}</span>
                )}
                <Switch
                  label={t('menuVisible')}
                  checked={!entry.hidden}
                  title={t('menuVisibleHint')}
                  onChange={() => { toggleHidden(alias, entry) }}
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