import type { RecipeDraft } from '@rill/protocol'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { catalog } from '../src/fixtures'
import { recipeDrafts } from '../src/fixtures/recipes'
import { createTranslator } from '../src/i18n'
import { ko } from '../src/i18n/ko'
import { DraftPreview, type DraftPreviewProps } from '../src/recipes/DraftPreview'
import { violations } from './axe'
import { renderThemed } from './render'

const t = createTranslator('ko')
const RECEIPT = recipeDrafts['receipt-folder-to-csv']!
const ALERT = recipeDrafts['receipt-big-amount-alert']!
const HEALTH = recipeDrafts['daily-health-check']!

function setup(draft: RecipeDraft, props: Partial<DraftPreviewProps> = {}, locale: 'ko' | 'en' = 'ko') {
  const onDeploy = vi.fn()
  const onEdit = vi.fn()
  const onAction = vi.fn()
  const onDone = vi.fn()
  const view = renderThemed(<DraftPreview draft={draft} catalog={catalog} deploy={{ phase: 'idle' }} onDeploy={onDeploy} onEdit={onEdit} onAction={onAction} onDone={onDone} {...props} />, { locale })
  return { onDeploy, onEdit, onAction, onDone, view, user: userEvent.setup() }
}

describe('DraftPreview content', () => {
  it('draws the workflow of the draft as a read-only graph', () => {
    setup(HEALTH)
    const graph = screen.getByRole('region', { name: ko['graph.label'] })
    expect(graph).toBeTruthy()
    for (const node of HEALTH.workflow.nodes) expect(screen.getAllByText(new RegExp(node.id)).length, node.id).toBeGreaterThan(0)
  })

  it('shows one line per side effect', () => {
    setup(ALERT)
    const lines = within(screen.getByRole('list', { name: ko['recipes.preview.effects'] })).getAllByRole('listitem')
    expect(lines.map((line) => line.textContent)).toEqual([ko['recipes.preview.effect.idempotent'], ko['recipes.preview.effect.external']])
  })

  it('shows the network line only for a recipe that calls out', () => {
    setup(HEALTH)
    const lines = within(screen.getByRole('list', { name: ko['recipes.preview.effects'] })).getAllByRole('listitem')
    expect(lines.map((line) => line.textContent)).toEqual([ko['recipes.preview.effect.external']])
  })

  it('says so when the workflow has no side effect', () => {
    setup({ ...HEALTH, summary: { ...HEALTH.summary, sideEffects: [] } })
    expect(screen.getByText(ko['recipes.preview.effect.none'])).toBeTruthy()
  })

  it('shows a prominent external transfer line when the draft sends to the model', () => {
    setup(RECEIPT)
    const line = screen.getByRole('note')
    expect(line.textContent).toContain(ko['badge.externalTransfer'])
    expect(line.textContent).toContain(ko['badge.externalTransfer.hint'])
  })

  it('shows no external transfer line when it does not', () => {
    setup(HEALTH)
    expect(screen.queryByRole('note')).toBeNull()
    expect(screen.queryByText(ko['badge.externalTransfer'])).toBeNull()
  })
})

describe('DraftPreview deploy', () => {
  it('calls onDeploy from the deploy button only', async () => {
    const { user, onDeploy, onAction } = setup(HEALTH)
    expect(onDeploy).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: ko['recipes.preview.deploy'] }))
    expect(onDeploy).toHaveBeenCalledTimes(1)
    expect(onAction).not.toHaveBeenCalled()
  })

  it('shows a disabled button while deploying', () => {
    setup(HEALTH, { deploy: { phase: 'deploying' } })
    expect((screen.getByRole('button', { name: ko['recipes.preview.deploying'] }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('goes back to the values from the edit button', async () => {
    const { user, onEdit } = setup(HEALTH)
    await user.click(screen.getByRole('button', { name: ko['recipes.preview.edit'] }))
    expect(onEdit).toHaveBeenCalledTimes(1)
  })

  it('shows the workflow id after a deploy and offers a dry run and activation that only call onAction', async () => {
    const { user, onAction, onDeploy } = setup(HEALTH, { deploy: { phase: 'deployed', workflowId: 'wf-1' } })
    expect(screen.getByText(t('recipes.preview.deployed', { id: 'wf-1' }))).toBeTruthy()
    expect(screen.getByText(ko['recipes.preview.notActive'])).toBeTruthy()
    expect(screen.queryByRole('button', { name: ko['recipes.preview.deploy'] })).toBeNull()
    await user.click(screen.getByRole('button', { name: ko['recipes.preview.dryRun'] }))
    await user.click(screen.getByRole('button', { name: ko['recipes.preview.activate'] }))
    expect(onAction.mock.calls).toEqual([['dry_run', 'wf-1'], ['activate', 'wf-1']])
    expect(onDeploy).not.toHaveBeenCalled()
  })

  it('offers to pick another recipe after a deploy', async () => {
    const { user, onDone } = setup(HEALTH, { deploy: { phase: 'deployed', workflowId: 'wf-1' } })
    await user.click(screen.getByRole('button', { name: ko['recipes.preview.another'] }))
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('shows a deploy failure with a retry through the deploy button', async () => {
    const { user, onDeploy } = setup(HEALTH, { deploy: { phase: 'failed', key: 'recipes.deployError.invalid' } })
    expect(screen.getByRole('alert').textContent).toContain(ko['recipes.deployError.invalid'])
    await user.click(screen.getByRole('button', { name: ko['recipes.preview.deploy'] }))
    expect(onDeploy).toHaveBeenCalledTimes(1)
  })

  it('renders a workflow id from the server as text', () => {
    const { view } = setup(HEALTH, { deploy: { phase: 'deployed', workflowId: '<img src=x onerror=alert(1)>' } })
    expect(view.container.querySelector('img')).toBeNull()
    expect(view.container.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('has no axe violations idle, deployed or failed, and in English', async () => {
    for (const deploy of [{ phase: 'idle' }, { phase: 'deployed', workflowId: 'wf-1' }, { phase: 'failed', key: 'recipes.deployError.generic' }] as const) {
      const { view } = setup(RECEIPT, { deploy })
      expect(await violations(view.container)).toEqual([])
      view.unmount()
    }
    const english = setup(RECEIPT, {}, 'en')
    expect(await violations(english.view.container)).toEqual([])
  })
})
