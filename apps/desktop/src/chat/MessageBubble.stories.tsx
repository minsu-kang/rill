import type { Meta, StoryObj } from '@storybook/react-vite'
import { attachmentRefs, results } from '../fixtures/plan'
import { MessageBubble, UserMessage } from './MessageBubble'

const asked = results.questions as Extract<typeof results.questions, { kind: 'questions' }>

function Column({ children }: { children: React.ReactNode }) {
  return <div style={{ width: 460, padding: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>{children}</div>
}

const meta = { title: 'Chat/MessageBubble', component: MessageBubble, args: { role: 'user', children: null } } satisfies Meta<typeof MessageBubble>

export default meta

type Story = StoryObj<typeof meta>

export const UserText: Story = {
  name: 'User text',
  render: () => (
    <Column>
      <MessageBubble role="user">
        <UserMessage entry={{ role: 'user', text: '폴더에 영수증 PDF가 들어오면 금액과 날짜를 CSV에 정리해 줘', attachments: [] }} />
      </MessageBubble>
    </Column>
  ),
}

export const UserWithAttachments: Story = {
  name: 'User with attachments',
  render: () => (
    <Column>
      <MessageBubble role="user">
        <UserMessage entry={{ role: 'user', text: '첨부한 영수증처럼 정리해 줘', attachments: [attachmentRefs.pdf, attachmentRefs.png, attachmentRefs.hostile] }} />
      </MessageBubble>
    </Column>
  ),
}

export const UserAnswers: Story = {
  name: 'User answers',
  render: () => (
    <Column>
      <MessageBubble role="user">
        <UserMessage entry={{ role: 'user', text: '', attachments: [], answers: { folder: '~/Downloads', notify: 'slack-ops', fields: '날짜, 금액' } }} questions={asked.questions} />
      </MessageBubble>
    </Column>
  ),
}

export const AssistantText: Story = {
  name: 'Assistant text',
  render: () => (
    <Column>
      <MessageBubble role="assistant">장부에 한 줄씩 추가하는 워크플로우를 만들었어요.</MessageBubble>
    </Column>
  ),
}

export const HostileUserText: Story = {
  name: 'Hostile user text',
  render: () => (
    <Column>
      <MessageBubble role="user">
        <UserMessage entry={{ role: 'user', text: `<img src=x onerror=alert(1)> **bold** ‮exe ${'long '.repeat(200)}`, attachments: [], answers: { '<b>id</b>': '<a href="https://evil.example">y</a>' } }} />
      </MessageBubble>
    </Column>
  ),
}
