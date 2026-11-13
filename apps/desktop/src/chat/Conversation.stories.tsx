import type { MethodName, MethodParams, MethodResult } from '@rill/protocol'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useMemo } from 'react'
import type { EngineClient } from '../engine/client'
import { createFakeClient } from '../engine/fake-client'
import { withPlanMethods } from '../engine/fake-plan'
import { catalog, fakeData } from '../fixtures'
import { memoryFixtures, metas, models, outcomeOf, results } from '../fixtures/plan'
import type { AttachmentPort } from './Composer'
import { Conversation, type ConversationProps } from './Conversation'
import type { ConversationEntry } from './model/conversation'

const port: AttachmentPort = {
  async add(file) {
    return { id: `att-story-${file.name.length}-xxxxxxxx`, mediaType: 'text/plain', name: file.name, bytes: file.size }
  },
}

function clientOf(): EngineClient {
  const client = withPlanMethods(createFakeClient(fakeData), { models, script: () => outcomeOf(results.workflow), memory: [...memoryFixtures.three], delayMs: 500 })
  return { request: <M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> => client.request(method, params), onEvent: client.onEvent }
}

function Demo({ initialEntries, initialDraft }: Pick<ConversationProps, 'initialEntries' | 'initialDraft'>) {
  const client = useMemo(() => clientOf(), [])
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: 420, height: 640, border: '1px solid var(--border-default)' }}>
      <Conversation
        client={client}
        port={port}
        catalog={catalog}
        newId={() => `story-${Math.random().toString(36).slice(2)}`}
        modelsState={{ status: 'ready', models }}
        onRetryModels={() => undefined}
        memoryCount={memoryFixtures.three.length}
        tabId="story-tab"
        panelId="story-panel"
        labelledBy="story-label"
        hidden={false}
        active
        canOpenNew
        onNewChat={() => undefined}
        report={() => undefined}
        initialEntries={initialEntries}
        initialDraft={initialDraft}
      />
    </div>
  )
}

const meta = { title: 'Chat/Conversation', component: Conversation } satisfies Meta<typeof Conversation>

export default meta

type Story = StoryObj<typeof meta>

const unused = {} as ConversationProps

const answered: ConversationEntry[] = [
  { role: 'user', text: '폴더에 영수증 PDF가 들어오면 금액과 날짜를 CSV에 정리해 줘', attachments: [] },
  { role: 'assistant', planId: 'story-plan-1', result: results.workflow, meta: metas.plain },
]

export const Empty: Story = { args: unused, render: () => <Demo /> }

export const WithAnswer: Story = { name: 'With an answer', args: unused, render: () => <Demo initialEntries={answered} initialDraft="그리고 슬랙으로도 알려 줘" /> }
