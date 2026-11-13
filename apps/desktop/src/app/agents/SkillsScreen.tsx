import type { SkillField } from '@rill/protocol'
import { useRef, useState } from 'react'
import { plainText } from '../../chat/model/clamp'
import { planErrorKey } from '../../chat/model/errors'
import { useAgents } from '../../engine/agents'
import type { EngineClient } from '../../engine/client'
import { agentsUsingSkill, useSkills } from '../../engine/skills'
import { useT, type MessageKey } from '../../i18n'
import { HostError, type HostApi } from '../../shared/host-api'
import { SafeText } from '../../ui/SafeText'
import { TransferIcon } from '../../ui/TransferMark'
import { useStepFocus } from '../../ui/useStepFocus'
import visuallyHidden from '../../ui/visuallyHidden.module.css'
import controls from '../controls.module.css'
import { hostErrorKey } from '../settings/errors'
import { useAction } from '../settings/useAction'
import { ConfirmDialog } from '../workflows/ConfirmDialog'
import styles from './AgentsScreen.module.css'
import { exportFileName } from './model/review'
import { skillDraftOf } from './model/skill-draft'
import { skillReviewOutcome } from './model/skill-review'
import { skillSelectionOf, useSkillsView, type SkillViewAction } from './model/skill-view'
import { SkillEditor } from './SkillEditor'
import { parseSkillFile, serialiseSkillFile } from './skill-file'
import { SkillImportReview } from './SkillImportReview'
import { SkillList } from './SkillList'

export interface SkillsScreenProps {
  client: EngineClient
  files?: Pick<HostApi['dialogs'], 'openText' | 'saveText'>
}

type Asking = { kind: 'unsaved'; then: SkillViewAction; review: boolean; importAfter?: true } | { kind: 'delete' }

function actionError(error: unknown): MessageKey {
  return error instanceof HostError ? hostErrorKey(error) : planErrorKey(error)
}

export function SkillsScreen({ client, files }: SkillsScreenProps) {
  const t = useT()
  const { state: skills, store } = useSkills(client)
  const { state: agents } = useAgents(client)
  const { state: view, store: viewStore } = useSkillsView(client)
  const action = useAction(actionError)
  const [status, setStatus] = useState<MessageKey | undefined>(undefined)
  const [asking, setAsking] = useState<Asking | undefined>(undefined)
  const [exportProblem, setExportProblem] = useState(false)
  const root = useRef<HTMLElement>(null)
  const selection = skillSelectionOf(view, skills.skills)
  const ready = skills.status === 'ready' || skills.skills.length > 0
  const review = view.review
  const outcome = review === undefined ? undefined : skillReviewOutcome(review, skills.skills)
  const skill = selection.skill
  const selectedKey = review !== undefined ? '\u0000review' : selection.creating ? '\u0000new' : (skill?.id ?? '')
  const heading = useStepFocus(selectedKey, { container: root, scope: ready ? 'ready' : 'loading' })
  const users = skill === undefined ? [] : agentsUsingSkill(agents.agents, skill.id)

  function go(next: SkillViewAction): void {
    setStatus(undefined)
    setExportProblem(false)
    action.clearError()
    viewStore.dispatch(next)
  }

  function guarded(next: SkillViewAction): void {
    const same = next.type === 'select' && review === undefined && !selection.creating && skill?.id === next.id
    if (same) return
    if (review !== undefined) setAsking({ kind: 'unsaved', then: next, review: true })
    else if (selection.dirty) setAsking({ kind: 'unsaved', then: next, review: false })
    else go(next)
  }

  function startImport(): void {
    if (selection.dirty) setAsking({ kind: 'unsaved', then: { type: 'revert' }, review: false, importAfter: true })
    else importFile()
  }

  function edit(field: SkillField, value: string): void {
    setStatus(undefined)
    viewStore.dispatch({ type: 'edit', field, value, base: selection.baseline, id: skill?.id })
  }

  function save(): void {
    const draft = selection.draft
    const id = selection.creating ? undefined : skill?.id
    const creating = selection.creating
    setStatus(undefined)
    void action.run(async () => {
      const saved = await store.save({ ...draft, ...(id === undefined ? {} : { id }) })
      viewStore.dispatch({ type: 'saved', id: saved.id })
      setStatus(creating ? 'skills.status.created' : 'skills.status.saved')
    })
  }

  function importFile(): void {
    if (files === undefined) return
    setStatus(undefined)
    void action.run(async () => {
      const file = await files.openText()
      if (file === undefined) return
      viewStore.dispatch({ type: 'review', fileName: file.name, parsed: parseSkillFile(file.text) })
    })
  }

  function saveImport(): void {
    if (outcome?.fields === undefined || !outcome.canSave) return
    const fields = outcome.fields
    setStatus(undefined)
    void action.run(async () => {
      const saved = await store.save(fields)
      viewStore.dispatch({ type: 'saved', id: saved.id })
      setStatus('skills.status.imported')
    })
  }

  function exportFile(): void {
    if (files === undefined || skill === undefined) return
    const serialised = serialiseSkillFile(skillDraftOf(skill))
    setStatus(undefined)
    if (!serialised.ok) {
      setExportProblem(true)
      return
    }
    setExportProblem(false)
    const text = serialised.text
    const suggestedName = exportFileName(skill.name, 'skill')
    void action.run(async () => {
      const result = await files.saveText({ suggestedName, text })
      if (result.saved) setStatus('skills.status.exported')
    })
  }

  function remove(): void {
    if (skill === undefined) return
    const id = skill.id
    void action.run(async () => {
      await store.remove(id)
      viewStore.dispatch({ type: 'deselect' })
      setAsking(undefined)
      setStatus('skills.status.deleted')
    })
  }

  return (
    <section ref={root} className={styles.root} aria-labelledby="skills-screen-title">
      <header className={styles.head}>
        <h2 id="skills-screen-title" className={visuallyHidden.hidden}>
          {t('skills.screen.title')}
        </h2>
        <p className={controls.note}>{t('skills.screen.intro')}</p>
        <p className={`${controls.note} ${styles.transfer}`}>
          <TransferIcon />
          <span>{t('skills.screen.transfer')}</span>
        </p>
      </header>
      {skills.status === 'loading' && !ready ? (
        <p className={controls.note} role="status">
          {t('skills.screen.loading')}
        </p>
      ) : null}
      {skills.status === 'error' && !ready ? (
        <div className={styles.loadError}>
          <p className={controls.error} role="alert">
            {t('skills.screen.loadError')}
          </p>
          <div className={controls.row}>
            <button type="button" className={controls.button} onClick={() => void store.refresh()}>
              {t('skills.screen.retry')}
            </button>
          </div>
        </div>
      ) : null}
      {ready ? (
        <div className={styles.body}>
          <SkillList
            skills={skills.skills}
            agents={agents.agents}
            selectedId={review === undefined ? skill?.id : undefined}
            creating={selection.creating && review === undefined}
            onSelect={(id) => guarded({ type: 'select', id })}
            onCreate={() => guarded({ type: 'create' })}
            {...(files === undefined ? {} : { onImport: startImport })}
          />
          {review !== undefined && outcome !== undefined ? (
            <SkillImportReview
              review={review}
              outcome={outcome}
              busy={action.busy}
              error={asking === undefined ? action.error : undefined}
              headingRef={heading}
              onEdit={(field, value) => viewStore.dispatch({ type: 'reviewEdit', field, value })}
              onSave={saveImport}
              onCancel={() => go({ type: 'reviewClose' })}
            />
          ) : (
            <SkillEditor
              skill={skill}
              creating={selection.creating}
              draft={selection.draft}
              dirty={selection.dirty}
              busy={action.busy}
              error={asking?.kind === 'delete' ? undefined : exportProblem ? 'skills.export.headingInText' : action.error}
              status={status}
              users={users}
              headingRef={heading}
              onChange={edit}
              onSave={save}
              onRevert={() => go({ type: 'revert' })}
              onDelete={() => {
                action.clearError()
                setAsking({ kind: 'delete' })
              }}
              {...(files === undefined ? {} : { onExport: exportFile })}
            />
          )}
        </div>
      ) : null}
      {asking?.kind === 'unsaved' ? (
        <ConfirmDialog
          title={t('skills.unsaved.title')}
          message={t(asking.review ? 'skills.unsaved.messageImport' : 'skills.unsaved.message')}
          confirmLabel={t('skills.unsaved.confirm')}
          cancelLabel={t('skills.unsaved.cancel')}
          danger
          onConfirm={() => {
            const next = asking.then
            const importAfter = asking.importAfter === true
            setAsking(undefined)
            go(next)
            if (importAfter) importFile()
          }}
          onCancel={() => setAsking(undefined)}
        />
      ) : null}
      {asking?.kind === 'delete' && skill !== undefined ? (
        <ConfirmDialog
          title={t('skills.delete.title')}
          message={t('skills.delete.message', { name: plainText(skill.name, 60) })}
          details={
            agents.status !== 'ready' ? (
              <p className={controls.note}>{t('skills.delete.unknownAgents')}</p>
            ) : users.length === 0 ? (
              <p className={controls.note}>{t('skills.delete.none')}</p>
            ) : (
              <div className={styles.usedBy}>
                <p className={controls.note}>{t('skills.delete.agents')}</p>
                <ul className={styles.usedList}>
                  {users.map((agent) => (
                    <li key={agent.id}>
                      <SafeText text={agent.name} />
                    </li>
                  ))}
                </ul>
              </div>
            )
          }
          confirmLabel={t('skills.delete.confirm')}
          cancelLabel={t('skills.delete.cancel')}
          danger
          busy={action.busy}
          error={action.error === undefined ? undefined : t(action.error)}
          onConfirm={remove}
          onCancel={() => {
            action.clearError()
            setAsking(undefined)
          }}
        />
      ) : null}
    </section>
  )
}
