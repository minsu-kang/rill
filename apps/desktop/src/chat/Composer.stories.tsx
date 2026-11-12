import { RillError, type AttachmentRef, type LlmModelInfo, type LlmModelsResult } from '@rill/protocol'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useEffect, useRef, useState } from 'react'
import { memoryFixtures, models, modelsHaikuActive, modelsNothingConfigured } from '../fixtures/plan'
import { Composer, type AttachmentPort, type ComposerProps } from './Composer'
import type { EffortHint } from './model/effort'
import { activeModelOf } from './model/models'

const opus = activeModelOf(models)!
const haiku = activeModelOf(modelsHaikuActive)!

const HINTS: EffortHint[] = [
  { effort: 'low', costUsd: 0.012, latencyMs: 6_000, basis: 'planner evaluation, 48 cases' },
  { effort: 'medium', costUsd: 0.041, latencyMs: 14_000, basis: 'planner evaluation, 48 cases' },
  { effort: 'high', costUsd: 0.09, latencyMs: 31_000, basis: 'planner evaluation, 48 cases' },
]

let serial = 0
const goodPort: AttachmentPort = {
  async add(file) {
    serial += 1
    await new Promise((resolve) => setTimeout(resolve, 300))
    return { id: `att-story-${String(serial).padStart(4, '0')}`, mediaType: 'text/plain', name: file.name, bytes: file.size }
  },
}
const rejectingPort: AttachmentPort = {
  add: () => Promise.reject(new RillError('ATTACHMENT_REJECTED', 'ignored server text')),
}

type Initial = ComposerProps['state']
const EMPTY: Initial = { draft: '', attachments: [], effort: 'medium', useMemory: true }

interface DemoProps {
  initial?: Partial<Initial>
  model?: LlmModelInfo
  models?: LlmModelsResult
  memoryCount?: number | null
  editContext?: ComposerProps['editContext']
  busy?: boolean
  port?: AttachmentPort
  hints?: EffortHint[]
  conversationAttachments?: number
  autoFiles?: File[]
}

function sized(file: File, size: number): File {
  Object.defineProperty(file, 'size', { value: size })
  return file
}

function Demo({ initial, model = opus, models: table = models, memoryCount = 3, editContext, busy = false, port = goodPort, hints, conversationAttachments, autoFiles }: DemoProps) {
  const [state, setState] = useState<Initial>({ ...EMPTY, ...initial })
  const [edit, setEdit] = useState(editContext)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (autoFiles === undefined) return
    const input = root.current?.querySelector<HTMLInputElement>('input[type="file"]')
    if (input === null || input === undefined) return
    Object.defineProperty(input, 'files', { configurable: true, value: autoFiles })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, [autoFiles])

  return (
    <div ref={root} style={{ width: 420, padding: 'var(--space-4)' }}>
      <Composer
        state={state}
        model={model}
        models={table}
        memoryCount={memoryCount === null ? undefined : memoryCount}
        editContext={edit}
        port={port}
        busy={busy}
        hints={hints}
        conversationAttachments={conversationAttachments}
        onChange={(patch) => setState((previous) => ({ ...previous, ...patch }))}
        onSend={() => setState((previous) => ({ ...previous, draft: '', attachments: [] }))}
        onCancel={() => undefined}
        onClearEditContext={() => setEdit(undefined)}
      />
    </div>
  )
}

const meta = { title: 'Chat/Composer', component: Composer } satisfies Meta<typeof Composer>

export default meta

type Story = StoryObj<typeof meta>

const unused = {} as ComposerProps

const ref = (id: string, name: string, mediaType: AttachmentRef['mediaType'], bytes: number): AttachmentRef => ({ id: `att-demo-${id}-1234`, name, mediaType, bytes })

export const Empty: Story = { args: unused, render: () => <Demo /> }

export const WithText: Story = { name: 'With text', args: unused, render: () => <Demo initial={{ draft: '폴더에 영수증 PDF가 들어오면 금액과 날짜를 CSV에 정리해 줘' }} /> }

export const Busy: Story = { args: unused, render: () => <Demo busy initial={{ effort: 'high' }} /> }

export const WithAttachments: Story = {
  name: 'With attachments',
  args: unused,
  render: () => (
    <Demo
      initial={{
        draft: '첨부한 영수증처럼 정리해 줘',
        attachments: [ref('1', 'Cafe Mori 영수증.pdf', 'application/pdf', 184_320), ref('2', 'receipt-photo.png', 'image/png', 2_100_000), ref('3', 'ledger-sample.csv', 'text/csv', 18_900)],
      }}
    />
  ),
}

export const ManyAttachments: Story = {
  name: 'Many attachments (five of five)',
  args: unused,
  render: () => (
    <Demo
      initial={{
        draft: 'x',
        attachments: Array.from({ length: 5 }, (_, i) => ref(String(i), `scan-${i + 1}.jpeg`, 'image/jpeg', 800_000 + i * 1000)),
      }}
    />
  ),
}

export const HostileAttachmentNames: Story = {
  name: 'Hostile attachment names',
  args: unused,
  render: () => (
    <Demo
      initial={{
        draft: 'x',
        attachments: [ref('1', 'invoice‮gpj.exe\u0007 ​final.pdf', 'application/pdf', 52_000), ref('2', `${'a'.repeat(251)}.pdf`, 'application/pdf', 70_000)],
      }}
    />
  ),
}

export const AttachmentErrors: Story = {
  name: 'Attachment errors',
  args: unused,
  render: () => (
    <Demo
      initial={{ draft: 'x' }}
      autoFiles={[
        new File(['x'], 'setup.exe', { type: 'application/x-msdownload' }),
        new File([''], 'empty.txt', { type: 'text/plain' }),
        sized(new File(['x'], 'huge-report.pdf', { type: 'application/pdf' }), 30 * 1024 * 1024),
      ]}
    />
  ),
}

export const PortRejects: Story = { name: 'The port rejects a file', args: unused, render: () => <Demo initial={{ draft: 'x' }} port={rejectingPort} autoFiles={[new File(['x'], 'notes.txt', { type: 'text/plain' })]} /> }

export const ConversationLimit: Story = {
  name: 'Conversation limit reached',
  args: unused,
  render: () => <Demo initial={{ draft: 'x' }} conversationAttachments={10} autoFiles={[new File(['x'], 'one-more.txt', { type: 'text/plain' })]} />,
}

export const EditContext: Story = { name: 'Edit context', args: unused, render: () => <Demo editContext={{ workflowId: 'wf-receipt', nodeId: 'extract' }} initial={{ draft: '슬랙으로 알려 줘' }} /> }

export const MemoryOn: Story = { name: 'Memory on', args: unused, render: () => <Demo memoryCount={memoryFixtures.three.length} initial={{ draft: 'x', useMemory: true }} /> }

export const MemoryOff: Story = { name: 'Memory off', args: unused, render: () => <Demo memoryCount={memoryFixtures.three.length} initial={{ draft: 'x', useMemory: false }} /> }

export const NotesNotLoaded: Story = { name: 'Notes not loaded', args: unused, render: () => <Demo memoryCount={null} initial={{ draft: 'x', useMemory: true }} /> }

export const NoNotes: Story = { name: 'No saved notes', args: unused, render: () => <Demo memoryCount={0} initial={{ draft: 'x' }} /> }

export const TextTooLong: Story = { name: 'Text too long', args: unused, render: () => <Demo initial={{ draft: 'a'.repeat(8100) }} /> }

export const ModelWithFewerEffortLevels: Story = { name: 'Model with fewer effort levels', args: unused, render: () => <Demo model={haiku} initial={{ draft: 'x', effort: 'xhigh' }} /> }

export const NoModelConfigured: Story = {
  name: 'No model configured',
  args: unused,
  render: () => <Demo model={undefined as unknown as LlmModelInfo} models={modelsNothingConfigured} initial={{ draft: 'x' }} />,
}

export const WithMeasuredHints: Story = { name: 'With measured hints', args: unused, render: () => <Demo hints={HINTS} initial={{ draft: 'x' }} /> }
