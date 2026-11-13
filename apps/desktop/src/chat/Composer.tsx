import { type AttachmentRef, type LlmModelInfo, type LlmModelsResult } from '@rill/protocol'
import { useEffect, useId, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import { useT } from '../i18n'
import { AttachmentChips } from './AttachmentChips'
import { EffortSlider } from './EffortSlider'
import { ExternalTransferNotice, type TransferItem } from './ExternalTransferNotice'
import { ATTACHMENT_LIMITS, attachmentReasonKey, checkAttachment } from './model/attachments'
import { markHidden } from './model/clamp'
import { memoryInUse, type ConversationState } from './model/conversation'
import type { EffortHint } from './model/effort'
import { planErrorKey } from './model/errors'
import styles from './Composer.module.css'

export interface AttachmentPort {
  add(file: File): Promise<AttachmentRef>
  remove?(id: string): Promise<void>
}

type ComposerState = Pick<ConversationState, 'draft' | 'attachments' | 'effort' | 'useMemory'>

export interface ComposerProps {
  state: ComposerState
  model: LlmModelInfo | undefined
  models: LlmModelsResult | undefined
  memoryCount: number | undefined
  editContext?: { workflowId: string; nodeId?: string }
  port: AttachmentPort
  busy: boolean
  disabled?: boolean
  conversationAttachments?: number
  hints?: readonly EffortHint[]
  onChange(patch: Partial<ComposerState>): void
  onSend(): void
  onCancel(): void
  onClearEditContext(): void
  inactive?: boolean
}

function PaperclipIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M13.5 7.5 8.1 12.9a3.2 3.2 0 0 1-4.5-4.5l5.6-5.6a2.1 2.1 0 0 1 3 3L6.8 11.1a1 1 0 0 1-1.5-1.5L10.4 4.5" />
    </svg>
  )
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" data-open={open ? 'true' : 'false'}>
      <path d="M4 2.5 7.5 6 4 9.5" />
    </svg>
  )
}

export const MAX_TEXT = 8000
const SHOW_COUNTER_FROM = 6400
const ACCEPT = 'application/pdf,image/png,image/jpeg,image/gif,image/webp,text/plain,text/csv,text/markdown,.pdf,.png,.jpg,.jpeg,.gif,.webp,.txt,.csv,.md,.markdown'

interface Failure {
  key: number
  name: string
  reason: string
}

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files')
}

function droppedFiles(transfer: DataTransfer | null): File[] {
  const files = Array.from(transfer?.files ?? [])
  const items = Array.from(transfer?.items ?? []).filter((item) => item.kind === 'file')
  return files.filter((_, index) => items[index]?.webkitGetAsEntry?.()?.isDirectory !== true)
}

export function Composer(props: ComposerProps) {
  const { state, model, models, memoryCount, editContext, port, busy, disabled = false, conversationAttachments = 0, hints } = props
  const t = useT()
  const [pending, setPending] = useState<Array<{ key: number; name: string }>>([])
  const [failures, setFailures] = useState<Failure[]>([])
  const [dragging, setDragging] = useState(false)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const optionsId = useId()
  const fileInput = useRef<HTMLInputElement>(null)
  const text = useRef<HTMLTextAreaElement>(null)
  const wasBusy = useRef(false)
  const mounted = useRef(true)
  const latest = useRef(props)
  const attachments = useRef<AttachmentRef[]>(state.attachments)
  const pendingCount = useRef(0)
  const serial = useRef(0)

  useLayoutEffect(() => {
    latest.current = props
  })

  useLayoutEffect(() => {
    attachments.current = state.attachments
  }, [state.attachments])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (wasBusy.current && !busy && (document.activeElement === null || document.activeElement === document.body)) text.current?.focus()
    wasBusy.current = busy
  }, [busy])

  const tooLong = state.draft.length > MAX_TEXT
  const canSend = !busy && !disabled && model !== undefined && state.draft.trim() !== '' && !tooLong && pending.length === 0

  function fail(name: string, reason: string): void {
    serial.current += 1
    const key = serial.current
    setFailures((previous) => [...previous, { key, name, reason }])
  }

  function addFiles(files: readonly File[]): void {
    if (files.length === 0 || busy || disabled) return
    setFailures([])
    let inMessage = attachments.current.length + pendingCount.current
    for (const file of files) {
      const check = checkAttachment(file, { inMessage, inConversation: conversationAttachments + inMessage })
      if (!check.ok) {
        fail(file.name, t(attachmentReasonKey(check.reason)))
        continue
      }
      inMessage += 1
      serial.current += 1
      const key = serial.current
      pendingCount.current += 1
      setPending((previous) => [...previous, { key, name: file.name }])
      port.add(file).then(
        (ref) => {
          pendingCount.current -= 1
          if (!mounted.current) {
            port.remove?.(ref.id)?.catch(() => undefined)
            return
          }
          setPending((previous) => previous.filter((item) => item.key !== key))
          attachments.current = [...attachments.current, ref]
          latest.current.onChange({ attachments: attachments.current })
        },
        (error: unknown) => {
          pendingCount.current -= 1
          if (!mounted.current) return
          setPending((previous) => previous.filter((item) => item.key !== key))
          fail(file.name, t(planErrorKey(error)))
        },
      )
    }
  }

  function remove(id: string): void {
    attachments.current = attachments.current.filter((item) => item.id !== id)
    props.onChange({ attachments: attachments.current })
    port.remove?.(id)?.catch(() => undefined)
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.nativeEvent.isComposing) return
    event.preventDefault()
    if (canSend) props.onSend()
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    const files = Array.from(event.clipboardData?.files ?? [])
    if (files.length === 0) return
    event.preventDefault()
    addFiles(files)
  }

  function onDragOver(event: DragEvent): void {
    if (!hasFiles(event)) return
    event.preventDefault()
    const blocked = busy || disabled
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = blocked ? 'none' : 'copy'
    setDragging(!blocked)
  }

  function onDrop(event: DragEvent): void {
    event.preventDefault()
    setDragging(false)
    addFiles(droppedFiles(event.dataTransfer))
  }

  const transfer: TransferItem[] = ['request']
  if (state.attachments.length > 0) transfer.push('attachments')
  const memoryOn = memoryInUse(state.useMemory, memoryCount)
  if (memoryOn) transfer.push('memory')
  const attachCount = state.attachments.length + pending.length

  return (
    <div className={styles.root} data-composer="" data-dragging={dragging ? 'true' : undefined} onDragOver={onDragOver} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
      {editContext === undefined ? null : (
        <div className={styles.edit}>
          <span>
            {editContext.nodeId === undefined
              ? t('chat.composer.editing', { workflow: markHidden(editContext.workflowId) })
              : t('chat.composer.editingNode', { workflow: markHidden(editContext.workflowId), node: markHidden(editContext.nodeId) })}
          </span>
          <button type="button" className={styles.link} onClick={props.onClearEditContext}>
            {t('chat.composer.clearEdit')}
          </button>
        </div>
      )}
      <AttachmentChips
        items={state.attachments}
        pending={pending}
        errors={failures}
        onRemove={remove}
      />
      <textarea
        ref={text}
        data-rill-composer=""
        {...(props.inactive === true ? { 'data-rill-inactive': '' } : {})}
        className={styles.text}
        aria-label={t('chat.composer.label')}
        placeholder={t('chat.composer.placeholder')}
        rows={3}
        value={state.draft}
        disabled={busy || disabled}
        onChange={(event) => props.onChange({ draft: event.target.value })}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      {dragging ? <p className={styles.drop}>{t('chat.attach.drop')}</p> : null}
      {tooLong ? (
        <p className={styles.error} role="alert">
          {t('chat.composer.tooLong', { max: MAX_TEXT })}
        </p>
      ) : null}
      {model === undefined && models !== undefined ? <p className={styles.warn}>{t('chat.composer.noModel')}</p> : null}
      <div className={styles.toolbar} data-rill-toolbar="">
        <div className={styles.attachGroup}>
          <button type="button" className={styles.attach} disabled={busy || disabled} onClick={() => fileInput.current?.click()}>
            <PaperclipIcon />
            {t('chat.composer.attachLabel')}
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            accept={ACCEPT}
            onChange={(event) => {
              addFiles(Array.from(event.target.files ?? []))
              event.target.value = ''
            }}
          />
          {attachCount > 0 ? <span className={styles.meta}>{t('chat.attach.counter', { count: attachCount, max: ATTACHMENT_LIMITS.perMessage })}</span> : null}
          {state.draft.length >= SHOW_COUNTER_FROM ? <span className={styles.meta}>{t('chat.composer.counter', { count: state.draft.length, max: MAX_TEXT })}</span> : null}
        </div>
        <div className={styles.effort}>
          <EffortSlider value={state.effort} onChange={(effort) => props.onChange({ effort })} model={model} hints={hints} disabled={busy} expanded={advanced} toggleHidden />
        </div>
        <div className={styles.send}>
          {busy ? (
            <>
              <span className={styles.meta} role="status">
                {t('chat.composer.sending')}
              </span>
              <button type="button" className={styles.secondary} onClick={props.onCancel}>
                {t('chat.composer.cancel')}
              </button>
            </>
          ) : (
            <button type="button" className={styles.primary} disabled={!canSend} title={pending.length > 0 ? t('chat.composer.uploading') : undefined} onClick={props.onSend}>
              {t('chat.composer.send')}
            </button>
          )}
        </div>
      </div>
      <div className={styles.optionsBar}>
        <button type="button" className={styles.optionsToggle} aria-expanded={optionsOpen} aria-controls={optionsId} onClick={() => setOptionsOpen(!optionsOpen)}>
          <ChevronIcon open={optionsOpen} />
          {t('chat.composer.options')}
        </button>
      </div>
      <div id={optionsId} className={styles.options} hidden={!optionsOpen}>
        <label className={styles.memory}>
          <input type="checkbox" checked={memoryOn} disabled={busy || memoryCount === undefined || memoryCount === 0} onChange={(event) => props.onChange({ useMemory: event.target.checked })} />
          <span>{memoryCount === undefined ? t('chat.composer.memoryUnknown') : memoryCount === 0 ? t('chat.composer.memoryNone') : t('chat.composer.memory', { count: memoryCount })}</span>
        </label>
        {state.effort === 'max' ? null : (
          <button type="button" className={styles.link} aria-expanded={advanced} disabled={busy} onClick={() => setAdvanced(!advanced)}>
            {t(advanced ? 'chat.effort.hideAdvanced' : 'chat.effort.showAdvanced')}
          </button>
        )}
      </div>
      <div className={styles.footer} data-rill-footer="">
        <ExternalTransferNotice items={transfer} />
        {busy ? null : <span className={styles.meta}>{t('chat.composer.shortcut')}</span>}
      </div>
    </div>
  )
}
