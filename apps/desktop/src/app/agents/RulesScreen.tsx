import { RULE_MAX_INPUT_CHARS, RULE_MAX_ITEMS, type NodeInfo, type PlanEffort, type Rule } from '@rill/protocol'
import { useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { EFFORT_STEPS, effortLabelOf } from '../../chat/model/effort'
import { errorCodeOf } from '../../engine/agents'
import type { EngineClient } from '../../engine/client'
import { useRules } from '../../engine/rules'
import { useT, type MessageKey, type Translate } from '../../i18n'
import { checkRuleValue, forbiddableNodes, isPlanEffort, splitRules, widensCap, type RuleProblem } from '../../model/rules'
import { SafeText } from '../../ui/SafeText'
import visuallyHidden from '../../ui/visuallyHidden.module.css'
import controls from '../controls.module.css'
import type { CatalogStatus } from '../glue/useEngineData'
import { useAction } from '../settings/useAction'
import { ConfirmDialog } from '../workflows/ConfirmDialog'
import { ExistingWorkflows } from './ExistingWorkflows'
import styles from './RulesScreen.module.css'

export interface RulesScreenProps {
  client: EngineClient
  catalog: readonly NodeInfo[]
  catalogStatus?: CatalogStatus
  onRetryCatalog?(): void
}

type Group = 'forbid' | 'hosts' | 'cap'

type Asking = { kind: 'remove'; rule: Rule } | { kind: 'raise'; to: PlanEffort }

interface Notice {
  group: Group
  key: MessageKey
  effort?: PlanEffort
}

const PROBLEM_KEYS: Readonly<Record<RuleProblem, MessageKey>> = {
  empty: 'rules.problem.empty',
  control_character: 'rules.problem.control_character',
  line_separator: 'rules.problem.line_separator',
  bidi_format: 'rules.problem.bidi_format',
  format_character: 'rules.problem.format_character',
  too_long: 'rules.problem.too_long',
  unknown_node_type: 'rules.problem.unknown_node_type',
  unknown_effort: 'rules.problem.unknown_effort',
  host_scheme: 'rules.problem.host_scheme',
  host_path: 'rules.problem.host_path',
  host_port: 'rules.problem.host_port',
  host_user_info: 'rules.problem.host_user_info',
  host_space: 'rules.problem.host_space',
  host_empty_label: 'rules.problem.host_empty_label',
  host_wildcard: 'rules.problem.host_wildcard',
  host_characters: 'rules.problem.host_characters',
  host_label_length: 'rules.problem.host_label_length',
  host_too_long: 'rules.problem.host_too_long',
  host_idn: 'rules.problem.host_idn',
}

const CATALOG_KEYS: Readonly<Record<CatalogStatus, MessageKey>> = {
  loading: 'rules.forbid.catalogLoading',
  error: 'rules.forbid.catalogError',
  ready: 'rules.forbid.catalogNone',
}

const ERROR_KEYS: Readonly<Record<string, MessageKey>> = {
  RULE_FULL: 'rules.error.RULE_FULL',
  RULE_DUPLICATE: 'rules.error.RULE_DUPLICATE',
  RULE_NOT_FOUND: 'rules.error.RULE_NOT_FOUND',
}

function ruleErrorKey(error: unknown): MessageKey {
  const code = errorCodeOf(error)
  if (code === 'RULE_INVALID') {
    const problems = (error as { problems?: unknown }).problems
    const first = Array.isArray(problems) && typeof problems[0] === 'string' ? problems[0] : ''
    const id = first.split(':')[0]!.trim()
    return Object.hasOwn(PROBLEM_KEYS, id) ? PROBLEM_KEYS[id as RuleProblem] : 'rules.error.RULE_INVALID'
  }
  return code !== undefined && Object.hasOwn(ERROR_KEYS, code) ? ERROR_KEYS[code]! : 'rules.error.generic'
}

function say(t: Translate, key: MessageKey): string {
  return t(key, { max: RULE_MAX_ITEMS, chars: RULE_MAX_INPUT_CHARS })
}

export function RulesScreen({ client, catalog, catalogStatus = 'ready', onRetryCatalog }: RulesScreenProps) {
  const t = useT()
  const { state, store } = useRules(client)
  const action = useAction(ruleErrorKey)
  const [forbidChoice, setForbidChoice] = useState('')
  const [hostText, setHostText] = useState('')
  const [asking, setAsking] = useState<Asking | undefined>(undefined)
  const [pendingCap, setPendingCap] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<Notice | undefined>(undefined)
  const [origin, setOrigin] = useState<Group>('hosts')
  const [changes, setChanges] = useState(0)
  const ids = { title: useId(), forbid: useId(), hosts: useId(), cap: useId() }
  const fieldIds = { node: useId(), host: useId(), cap: useId(), hostHint: useId(), hostProblem: useId() }
  const nodeSelect = useRef<HTMLSelectElement>(null)
  const hostInput = useRef<HTMLInputElement>(null)
  const capSelect = useRef<HTMLSelectElement>(null)
  const forbidHeading = useRef<HTMLHeadingElement>(null)
  const hostsHeading = useRef<HTMLHeadingElement>(null)

  const nodes = useMemo(() => forbiddableNodes(catalog), [catalog])
  const nodeTypes = useMemo(() => new Set(nodes.map((node) => node.type)), [nodes])
  const ready = state.status === 'ready' || state.rules.length > 0
  const groups = splitRules(state.rules)
  const full = state.rules.length >= RULE_MAX_ITEMS
  const titleOf = (type: string): string => {
    const known = nodes.find((node) => node.type === type)
    return known === undefined ? type : `${known.title} (${type})`
  }
  const available = nodes.filter((node) => !groups.forbidden.some((rule) => rule.value === node.type))
  const savedCap = groups.cap !== undefined && isPlanEffort(groups.cap.value) ? groups.cap.value : undefined
  const capValue = savedCap ?? 'none'
  const capChoice = pendingCap ?? capValue
  const capLocked = full && groups.cap === undefined
  const canSaveCap = capChoice !== capValue && !capLocked && !action.busy
  const stepName = (effort: PlanEffort): string => t(`chat.effort.${effortLabelOf(effort)}`)

  const hostCheck = hostText.trim() === '' ? undefined : checkRuleValue('allowHost', hostText, nodeTypes)
  const hostValue = hostCheck?.ok === true ? hostCheck.value : undefined
  const hostDuplicate = hostValue !== undefined && groups.hosts.some((rule) => rule.value === hostValue)
  const hostProblem: MessageKey | undefined = hostCheck === undefined ? undefined : !hostCheck.ok ? PROBLEM_KEYS[hostCheck.problem] : hostDuplicate ? 'rules.problem.duplicate' : undefined
  const hostSavedAs = hostValue !== undefined && !hostDuplicate && hostValue !== hostText.trim() ? hostValue : undefined
  const canAddHost = hostValue !== undefined && !hostDuplicate && !full && !action.busy
  const canAddNode = forbidChoice !== '' && !full && !action.busy

  function run(group: Group, work: () => Promise<void>): void {
    setOrigin(group)
    setNotice(undefined)
    void action.run(work)
  }

  function addNode(event: FormEvent): void {
    event.preventDefault()
    const type = forbidChoice
    if (!canAddNode) return
    run('forbid', async () => {
      await store.save('forbidNode', type)
      setForbidChoice('')
      setNotice({ group: 'forbid', key: 'rules.status.added' })
      setChanges((value) => value + 1)
      nodeSelect.current?.focus()
    })
  }

  function addHost(event: FormEvent): void {
    event.preventDefault()
    const text = hostText
    if (!canAddHost) return
    run('hosts', async () => {
      await store.save('allowHost', text)
      setHostText('')
      setNotice({ group: 'hosts', key: 'rules.status.added' })
      setChanges((value) => value + 1)
      hostInput.current?.focus()
    })
  }

  function chooseCap(value: string): void {
    setNotice(undefined)
    action.clearError()
    setPendingCap(value)
  }

  function applyCap(choice: PlanEffort | 'none'): void {
    run('cap', async () => {
      if (choice === 'none') {
        if (groups.cap !== undefined) await store.remove(groups.cap.id)
        setNotice({ group: 'cap', key: 'rules.status.capRemoved' })
      } else {
        await store.save('maxPlanEffort', choice)
        setNotice({ group: 'cap', key: 'rules.status.capSet', effort: choice })
      }
      setPendingCap(undefined)
    })
  }

  function saveCap(): void {
    if (!canSaveCap || (capChoice !== 'none' && !isPlanEffort(capChoice))) return
    const choice = capChoice as PlanEffort | 'none'
    if (!widensCap(savedCap, choice)) {
      applyCap(choice)
      return
    }
    setOrigin('cap')
    setNotice(undefined)
    action.clearError()
    if (choice !== 'none') setAsking({ kind: 'raise', to: choice })
    else if (groups.cap !== undefined) setAsking({ kind: 'remove', rule: groups.cap })
  }

  function askToRemove(rule: Rule, group: Group): void {
    setOrigin(group)
    setNotice(undefined)
    action.clearError()
    setAsking({ kind: 'remove', rule })
  }

  function raise(): void {
    if (asking?.kind !== 'raise') return
    const to = asking.to
    setOrigin('cap')
    void action.run(async () => {
      await store.save('maxPlanEffort', to)
      setAsking(undefined)
      setPendingCap(undefined)
      setNotice({ group: 'cap', key: 'rules.status.capSet', effort: to })
    })
  }

  function remove(): void {
    if (asking?.kind !== 'remove') return
    const rule = asking.rule
    const group: Group = rule.kind === 'forbidNode' ? 'forbid' : rule.kind === 'allowHost' ? 'hosts' : 'cap'
    setOrigin(group)
    void action.run(async () => {
      try {
        await store.remove(rule.id)
      } catch (error) {
        if (errorCodeOf(error) === 'RULE_NOT_FOUND') setAsking(undefined)
        throw error
      }
      setAsking(undefined)
      if (group === 'cap') setPendingCap(undefined)
      setNotice({ group, key: group === 'cap' ? 'rules.status.capRemoved' : 'rules.status.removed' })
      if (group !== 'cap') setChanges((value) => value + 1)
      const target = group === 'forbid' ? forbidHeading.current : group === 'hosts' ? hostsHeading.current : capSelect.current
      target?.focus()
    })
  }

  const noticeText = (group: Group): string => {
    if (notice === undefined || notice.group !== group) return ''
    return t(notice.key, notice.effort === undefined ? undefined : { step: stepName(notice.effort) })
  }
  const errorIn = (group: Group): MessageKey | undefined => (asking === undefined && origin === group ? action.error : undefined)

  function confirmBody() {
    if (asking === undefined) return null
    if (asking.kind === 'raise') {
      const from = savedCap === undefined ? '' : stepName(savedCap)
      return { title: t('rules.confirm.raiseTitle'), confirmLabel: t('rules.confirm.raiseConfirm'), message: t(asking.to === 'max' ? 'rules.confirm.raiseMax' : 'rules.confirm.raise', { from, step: stepName(asking.to) }), details: undefined }
    }
    const rule = asking.rule
    const base = { title: t('rules.confirm.title'), confirmLabel: t('rules.confirm.confirm') }
    if (rule.kind === 'forbidNode') return { ...base, message: t('rules.confirm.forbid', { name: rule.value }), details: undefined }
    if (rule.kind === 'allowHost') {
      const last = groups.hosts.length === 1
      return { ...base, message: t('rules.confirm.host', { host: rule.value }), details: <p className={controls.note}>{t(last ? 'rules.confirm.hostLast' : 'rules.confirm.hostMore')}</p> }
    }
    const step = isPlanEffort(rule.value) ? stepName(rule.value) : rule.value
    return { ...base, message: t('rules.confirm.cap', { step }), details: undefined }
  }

  const confirm = confirmBody()

  return (
    <section className={styles.root} aria-labelledby={ids.title}>
      <header className={styles.head}>
        <h2 id={ids.title} className={visuallyHidden.hidden}>
          {t('rules.screen.title')}
        </h2>
        <p className={controls.note}>{t('rules.screen.intro')}</p>
        <p className={controls.note}>{t('rules.screen.model')}</p>
      </header>
      {state.status === 'loading' && !ready ? (
        <p className={controls.note} role="status">
          {t('rules.screen.loading')}
        </p>
      ) : null}
      {state.status === 'error' ? (
        <div className={styles.loadError}>
          <p className={controls.error} role="alert">
            {t(ready ? 'rules.screen.staleError' : 'rules.screen.loadError')}
          </p>
          <div className={controls.row}>
            <button type="button" className={controls.button} onClick={() => void store.refresh()}>
              {t('rules.screen.retry')}
            </button>
          </div>
        </div>
      ) : null}
      {ready ? (
        <>
          <div className={styles.summary}>
            <span className={styles.count}>{t('rules.count', { count: state.rules.length, max: RULE_MAX_ITEMS })}</span>
            {full ? (
              <p className={controls.warn} role="note">
                {t('rules.full', { max: RULE_MAX_ITEMS })}
              </p>
            ) : null}
          </div>
          <div className={styles.groups}>
            <section className={styles.group} aria-labelledby={ids.forbid}>
              <h3 id={ids.forbid} ref={forbidHeading} tabIndex={-1} className={styles.groupTitle}>
                {t('rules.forbid.title')}
              </h3>
              <div className={styles.card}>
                <p className={controls.note}>{t('rules.forbid.intro')}</p>
                <form className={styles.addRow} onSubmit={addNode} noValidate>
                  <div className={styles.field}>
                    <label htmlFor={fieldIds.node} className={styles.label}>
                      {t('rules.forbid.select')}
                    </label>
                    <select
                      ref={nodeSelect}
                      id={fieldIds.node}
                      className={controls.input}
                      value={forbidChoice}
                      disabled={available.length === 0}
                      onChange={(event) => {
                        setForbidChoice(event.target.value)
                        action.clearError()
                      }}
                    >
                      <option value="">{t('rules.forbid.placeholder')}</option>
                      {available.map((node) => (
                        <option key={node.type} value={node.type}>
                          {`${node.title} (${node.type})`}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button type="submit" className={controls.primary} disabled={!canAddNode}>
                    {t('rules.add')}
                  </button>
                </form>
                {available.length > 0 ? null : nodes.length > 0 ? (
                  <p className={controls.note}>{t('rules.forbid.allUsed')}</p>
                ) : (
                  <>
                    <p className={catalogStatus === 'error' ? controls.error : controls.note}>{t(CATALOG_KEYS[catalogStatus])}</p>
                    {catalogStatus === 'error' && onRetryCatalog !== undefined ? (
                      <div className={controls.row}>
                        <button type="button" className={controls.button} onClick={onRetryCatalog}>
                          {t('rules.screen.retry')}
                        </button>
                      </div>
                    ) : null}
                  </>
                )}
                {groups.forbidden.length === 0 ? (
                  <p className={controls.note}>{t('rules.forbid.empty')}</p>
                ) : (
                  <ul className={controls.list} aria-label={t('rules.forbid.list')}>
                    {groups.forbidden.map((rule) => (
                      <li key={rule.id} className={styles.row}>
                        <span className={styles.rowName}>
                          <SafeText text={titleOf(rule.value)} />
                        </span>
                        <button type="button" className={controls.button} aria-label={t('rules.forbid.removeLabel', { name: titleOf(rule.value) })} onClick={() => askToRemove(rule, 'forbid')}>
                          {t('rules.remove')}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <p className={controls.ok} role="status" hidden={noticeText('forbid') === ''}>
                  {noticeText('forbid')}
                </p>
                {errorIn('forbid') === undefined ? null : (
                  <p className={controls.error} role="alert">
                    {say(t, errorIn('forbid')!)}
                  </p>
                )}
              </div>
            </section>
            <section className={styles.group} aria-labelledby={ids.hosts}>
              <h3 id={ids.hosts} ref={hostsHeading} tabIndex={-1} className={styles.groupTitle}>
                {t('rules.hosts.title')}
              </h3>
              <div className={styles.card}>
                <p className={controls.note}>{t('rules.hosts.intro')}</p>
                <form className={styles.addRow} onSubmit={addHost} noValidate>
                  <div className={styles.field}>
                    <label htmlFor={fieldIds.host} className={styles.label}>
                      {t('rules.hosts.label')}
                    </label>
                    <input
                      ref={hostInput}
                      id={fieldIds.host}
                      className={controls.input}
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={t('rules.hosts.placeholder')}
                      value={hostText}
                      aria-invalid={hostProblem === undefined ? undefined : 'true'}
                      aria-describedby={[fieldIds.hostHint, hostProblem === undefined ? undefined : fieldIds.hostProblem].filter((part) => part !== undefined).join(' ')}
                      onChange={(event) => {
                        setHostText(event.target.value)
                        action.clearError()
                      }}
                    />
                  </div>
                  <button type="submit" className={controls.primary} disabled={!canAddHost}>
                    {t('rules.add')}
                  </button>
                </form>
                <p id={fieldIds.hostHint} className={styles.hint}>
                  {t('rules.hosts.hint')}
                </p>
                {hostProblem === undefined ? null : (
                  <p id={fieldIds.hostProblem} className={controls.error}>
                    {say(t, hostProblem)}
                  </p>
                )}
                {hostSavedAs === undefined ? null : <p className={styles.hint}>{t('rules.hosts.savedAs', { value: hostSavedAs })}</p>}
                {groups.hosts.length === 0 ? (
                  <p className={controls.note}>{t('rules.hosts.empty')}</p>
                ) : (
                  <ul className={controls.list} aria-label={t('rules.hosts.list')}>
                    {groups.hosts.map((rule) => (
                      <li key={rule.id} className={styles.row}>
                        <span className={`${controls.mono} ${styles.rowName}`}>{rule.value}</span>
                        <button type="button" className={controls.button} aria-label={t('rules.hosts.removeLabel', { host: rule.value })} onClick={() => askToRemove(rule, 'hosts')}>
                          {t('rules.remove')}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <p className={styles.hint}>{t('rules.hosts.slackNote')}</p>
                <p className={controls.ok} role="status" hidden={noticeText('hosts') === ''}>
                  {noticeText('hosts')}
                </p>
                {errorIn('hosts') === undefined ? null : (
                  <p className={controls.error} role="alert">
                    {say(t, errorIn('hosts')!)}
                  </p>
                )}
              </div>
            </section>
            <section className={styles.group} aria-labelledby={ids.cap}>
              <h3 id={ids.cap} tabIndex={-1} className={styles.groupTitle}>
                {t('rules.cap.title')}
              </h3>
              <div className={styles.card}>
                <p className={controls.note}>{t('rules.cap.intro')}</p>
                <div className={styles.addRow}>
                  <div className={styles.capField}>
                    <label htmlFor={fieldIds.cap} className={styles.label}>
                      {t('rules.cap.label')}
                    </label>
                    <select ref={capSelect} id={fieldIds.cap} className={`${controls.input} ${styles.capSelect}`} value={capChoice} disabled={capLocked} onChange={(event) => chooseCap(event.target.value)}>
                      <option value="none">{t('rules.cap.none')}</option>
                      {EFFORT_STEPS.map((step) => (
                        <option key={step.effort} value={step.effort}>
                          {t(`chat.effort.${step.label}`)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button type="button" className={controls.primary} disabled={!canSaveCap} onClick={saveCap}>
                    {t('rules.cap.save')}
                  </button>
                </div>
                <p className={controls.ok} role="status" hidden={noticeText('cap') === ''}>
                  {noticeText('cap')}
                </p>
                {errorIn('cap') === undefined ? null : (
                  <p className={controls.error} role="alert">
                    {say(t, errorIn('cap')!)}
                  </p>
                )}
              </div>
            </section>
            <ExistingWorkflows client={client} version={changes} />
          </div>
        </>
      ) : null}
      {asking !== undefined && confirm !== null ? (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          details={confirm.details}
          confirmLabel={confirm.confirmLabel}
          cancelLabel={t('rules.confirm.cancel')}
          danger
          busy={action.busy}
          error={action.error === undefined ? undefined : say(t, action.error)}
          onConfirm={asking.kind === 'raise' ? raise : remove}
          onCancel={() => {
            action.clearError()
            if (asking.kind === 'raise' || asking.rule.kind === 'maxPlanEffort') setPendingCap(undefined)
            setAsking(undefined)
          }}
        />
      ) : null}
    </section>
  )
}
