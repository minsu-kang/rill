import { RillError, type MethodName, type MethodParams, type MethodResult } from '@rill/protocol'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useMemo, useState, type ReactNode } from 'react'
import type { EngineClient } from '../engine/client'
import { createFakeClient } from '../engine/fake-client'
import { withPlanMethods, type FakePlanData } from '../engine/fake-plan'
import { catalog, fakeData } from '../fixtures'
import { memoryFixtures, metas, models, modelsNothingConfigured, outcomeOf, results } from '../fixtures/plan'
import { useT } from '../i18n'
import { ChatPanel, type ChatPanelProps } from './ChatPanel'
import type { AttachmentPort } from './Composer'
import type { ConversationEntry } from './model/conversation'

let attachmentSerial = 0

const port: AttachmentPort = {
  async add(file) {
    await new Promise((resolve) => setTimeout(resolve, 300))
    attachmentSerial += 1
    return { id: `att-story-${String(attachmentSerial).padStart(4, '0')}`, mediaType: 'text/plain', name: file.name, bytes: file.size }
  },
}

type Script = FakePlanData['script']

function cycle(list: ReadonlyArray<ReturnType<Script>>): Script {
  let index = 0
  return () => {
    const next = list[Math.min(index, list.length - 1)]!
    index += 1
    return next
  }
}

function flow(): Script {
  let call = 0
  return () => {
    call += 1
    if (call === 1) return outcomeOf(results.questions)
    if (call === 2) return outcomeOf(results.flagged)
    return call % 2 === 1 ? outcomeOf(results.workflow, metas.memory) : outcomeOf(results.unsupported)
  }
}

function errors(): Script {
  return cycle([
    new RillError('LLM_UNAVAILABLE', 'x'),
    new RillError('PLAN_INVALID', 'x'),
    new RillError('PLAN_PROVIDER', 'x'),
    new RillError('PLAN_BUSY', 'x'),
    new RillError('INTERNAL', 'x'),
    outcomeOf(results.workflow),
  ])
}

interface World {
  script: () => Script
  models?: typeof models
  delayMs?: number
}

function clientOf(world: World, entries: readonly ConversationEntry[] = []): EngineClient {
  const client = withPlanMethods(createFakeClient(fakeData), {
    models: world.models ?? models,
    script: world.script(),
    memory: [...memoryFixtures.three],
    deployId: 'wf-story-1',
    delayMs: world.delayMs ?? 600,
    seed: entries.flatMap((entry) => (entry.role === 'assistant' && entry.deployed === undefined ? [{ planId: entry.planId, result: entry.result }] : [])),
  })
  const request = <M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> => client.request(method, params)
  return { request, onEvent: client.onEvent }
}

function Session({ world, ...rest }: { world: World } & Partial<ChatPanelProps>) {
  const client = useMemo(() => clientOf(world, rest.initialEntries), [world, rest.initialEntries])
  return <ChatPanel client={client} port={port} catalog={catalog} {...rest} />
}

function Demo({ world, children, ...rest }: { world: World; children?: ReactNode } & Partial<ChatPanelProps>) {
  const t = useT()
  const [round, setRound] = useState(0)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: 460, height: 760, border: '1px solid var(--border-default)' }}>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Session key={round} world={world} {...rest} />
      </div>
      <button type="button" onClick={() => setRound((value) => value + 1)} style={{ font: 'inherit', padding: 'var(--space-1)' }}>
        {t('chat.story.reset')}
      </button>
      {children}
    </div>
  )
}

const plainWorld: World = { script: () => () => outcomeOf(results.workflow) }
const flowWorld: World = { script: flow, delayMs: 700 }
const errorsWorld: World = { script: errors, delayMs: 200 }
const nothingWorld: World = { script: plainWorld.script, models: modelsNothingConfigured }
const patchWorld: World = { script: () => () => outcomeOf(results.patch) }

const user = (text: string, extra: Partial<Extract<ConversationEntry, { role: 'user' }>> = {}): ConversationEntry => ({ role: 'user', text, attachments: [], ...extra })

function longConversation(): ConversationEntry[] {
  const entries: ConversationEntry[] = []
  for (let i = 0; i < 12; i++) {
    entries.push(user(`요청 ${i + 1}: 폴더에 파일이 들어오면 알려 줘`))
    if (i === 3) entries.push({ role: 'assistant', planId: 'long-ok', result: results.workflow, meta: metas.plain, deployed: 'wf-long-1' })
    else if (i === 7) entries.push({ role: 'assistant', planId: 'long-flag', result: results.flagged, meta: metas.collapsed })
    else if (i % 3 === 1) entries.push({ role: 'assistant', planId: `long-q-${i}`, result: results.questions, meta: metas.memory })
    else entries.push({ role: 'assistant', planId: `long-${i}`, result: results.unsupported, meta: metas.nullCost })
  }
  return entries
}

const patchEntries: ConversationEntry[] = [
  user('extract에 통화 항목도 추가하고, 장부 대신 슬랙으로 알려 줘'),
  { role: 'assistant', planId: 'patch-1', result: results.patch, meta: metas.plain },
]

const meta = { title: 'Chat/ChatPanel', component: ChatPanel } satisfies Meta<typeof ChatPanel>

export default meta

type Story = StoryObj<typeof meta>

const unused = { client: {} as EngineClient, port, catalog } as const

export const Empty: Story = { args: unused, render: () => <Demo world={plainWorld} /> }

export const Flow: Story = { name: 'Flow (questions, flagged workflow, deploy)', args: unused, render: () => <Demo world={flowWorld} initialDraft="폴더에 청구서 PDF가 들어오면 합계를 외부로 보내 줘" /> }

export const Errors: Story = { name: 'Errors (each send fails differently)', args: unused, render: () => <Demo world={errorsWorld} initialDraft="폴더에 영수증이 들어오면 CSV에 적어 줘" /> }

export const NothingConfigured: Story = { name: 'Nothing configured', args: unused, render: () => <Demo world={nothingWorld} /> }

export const LongConversation: Story = { name: 'Long conversation', args: unused, render: () => <Demo world={plainWorld} initialEntries={longConversation()} /> }

export const Patch: Story = {
  args: unused,
  render: () => <Demo world={patchWorld} editContext={{ workflowId: 'wf-receipt', nodeId: 'extract' }} initialEntries={patchEntries} initialDraft="그리고 금액이 10만원을 넘으면 따로 알려 줘" />,
}

export const EditContextWithoutModel: Story = { name: 'Edit context without a model', args: unused, render: () => <Demo world={nothingWorld} editContext={{ workflowId: 'wf-receipt' }} /> }
