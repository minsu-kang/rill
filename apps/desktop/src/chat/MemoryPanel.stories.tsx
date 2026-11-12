import { RillError, type MemoryItem, type MethodName, type MethodParams, type MethodResult } from '@rill/protocol'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useEffect, useMemo, useRef } from 'react'
import type { EngineClient } from '../engine/client'
import { createFakeClient } from '../engine/fake-client'
import { withPlanMethods } from '../engine/fake-plan'
import { fakeData } from '../fixtures'
import { memoryFixtures, models, outcomeOf, results } from '../fixtures/plan'
import { MemoryPanel } from './MemoryPanel'

function clientOf(memory: MemoryItem[], override?: (method: MethodName) => Promise<never> | undefined): EngineClient {
  const client = withPlanMethods(createFakeClient(fakeData), { models, script: () => outcomeOf(results.workflow), memory: [...memory] })
  return {
    request: <M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> => override?.(method) ?? client.request(method, params),
    onEvent: client.onEvent,
  }
}

function Demo({ memory, override, tryToSave }: { memory: MemoryItem[]; override?: (method: MethodName) => Promise<never> | undefined; tryToSave?: string }) {
  const client = useMemo(() => clientOf(memory, override), [memory, override])
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (tryToSave === undefined) return undefined
    const timer = setTimeout(() => {
      const input = root.current?.querySelector<HTMLInputElement>('form input[type="text"]')
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      if (input === null || input === undefined || setter === undefined) return
      setter.call(input, tryToSave)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      setTimeout(() => root.current?.querySelector<HTMLButtonElement>('form button[type="submit"]')?.click(), 20)
    }, 120)
    return () => clearTimeout(timer)
  }, [tryToSave])

  return (
    <div ref={root} style={{ width: 460, padding: 'var(--space-4)' }}>
      <MemoryPanel client={client} />
    </div>
  )
}

const never = (method: MethodName): Promise<never> | undefined => (method === 'listMemory' ? new Promise<never>(() => undefined) : undefined)
const loadFails = (method: MethodName): Promise<never> | undefined => (method === 'listMemory' ? Promise.reject(new RillError('INTERNAL', 'x')) : undefined)
const saveFull = (method: MethodName): Promise<never> | undefined => (method === 'saveMemory' ? Promise.reject(new RillError('MEMORY_FULL', 'x')) : undefined)

const hostile: MemoryItem[] = [
  { id: 'h1', text: '<img src=x onerror=alert(1)> <a href="https://evil.example">click</a> **bold**', createdAt: 1, updatedAt: 1 },
  { id: 'h2', text: 'bidi ‮txt.exe and zero​width', createdAt: 2, updatedAt: 2 },
]

const meta = { title: 'Chat/MemoryPanel', component: MemoryPanel, args: { client: {} as EngineClient } } satisfies Meta<typeof MemoryPanel>

export default meta

type Story = StoryObj<typeof meta>

export const Empty: Story = { render: () => <Demo memory={memoryFixtures.empty} /> }

export const ThreeNotes: Story = { name: 'Three notes (0 to 20 states in between)', render: () => <Demo memory={memoryFixtures.three} /> }

export const Full: Story = { name: 'Twenty of twenty', render: () => <Demo memory={memoryFixtures.full} /> }

export const Loading: Story = { render: () => <Demo memory={[]} override={never} /> }

export const LoadFailed: Story = { name: 'Load failed', render: () => <Demo memory={[]} override={loadFails} /> }

export const DuplicateNote: Story = { name: 'Error: duplicate note', render: () => <Demo memory={memoryFixtures.three} tryToSave={memoryFixtures.three[0]!.text.toUpperCase()} /> }

export const NoteTooLong: Story = { name: 'Error: note too long', render: () => <Demo memory={memoryFixtures.three} tryToSave={'x'.repeat(320)} /> }

export const InvisibleCharacter: Story = { name: 'Error: invisible character', render: () => <Demo memory={memoryFixtures.three} tryToSave={'zero​width'} /> }

export const StoreFull: Story = { name: 'Error: the engine says it is full', render: () => <Demo memory={memoryFixtures.three} override={saveFull} tryToSave="one more" /> }

export const HostileNotes: Story = { name: 'Hostile notes', render: () => <Demo memory={hostile} /> }
