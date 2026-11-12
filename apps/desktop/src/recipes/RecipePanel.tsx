import type { NodeInfo, RecipeInfo } from '@rill/protocol'
import { useState } from 'react'
import type { EngineClient } from '../engine/client'
import type { MessageKey } from '../i18n'
import { DraftPreview } from './DraftPreview'
import { initialValues, type FormValues, type HostConnection } from './model/values'
import { RecipeForm } from './RecipeForm'
import { RecipeGallery } from './RecipeGallery'
import { useRecipeList, useRecipeSession } from './useRecipes'

export interface RecipePanelProps {
  client: EngineClient
  catalog: readonly NodeInfo[]
  connections: readonly HostConnection[]
  onPickPath?(kind: 'folder' | 'file'): Promise<string | undefined>
  onDeployed?(workflowId: string): void
  onAction?(action: 'activate' | 'dry_run', workflowId: string): void
}

export function RecipePanel({ client, catalog, connections, onPickPath, onDeployed, onAction }: RecipePanelProps) {
  const list = useRecipeList(client)
  const [chosen, setChosen] = useState<string | undefined>(undefined)
  const recipe = chosen === undefined ? undefined : list.recipes.find((item) => item.id === chosen)

  if (recipe === undefined) return <RecipeGallery recipes={list.recipes} status={list.status} catalog={catalog} onChoose={setChosen} onRetry={list.reload} />
  return (
    <RecipeFlow
      key={recipe.id}
      client={client}
      recipe={recipe}
      catalog={catalog}
      connections={connections}
      onPickPath={onPickPath}
      onDeployed={onDeployed}
      onAction={onAction}
      onLeave={() => setChosen(undefined)}
    />
  )
}

interface FlowProps extends Omit<RecipePanelProps, 'catalog'> {
  catalog: readonly NodeInfo[]
  recipe: RecipeInfo
  onLeave(): void
}

function RecipeFlow({ client, recipe, catalog, connections, onPickPath, onDeployed, onAction, onLeave }: FlowProps) {
  const [values, setValues] = useState<FormValues>(() => initialValues(recipe.params))
  const { session, submit, deploy, edit } = useRecipeSession(client, recipe.id, onDeployed)

  if (session.phase === 'draft') {
    return <DraftPreview draft={session.draft} catalog={catalog} deploy={session.deploy} onDeploy={deploy} onEdit={edit} onAction={onAction} onDone={onLeave} />
  }
  const failureKey: MessageKey | undefined = session.phase === 'failed' ? session.key : session.phase === 'invalid' && session.problems.length === 0 ? 'recipes.error.generic' : undefined
  return (
    <RecipeForm
      recipe={recipe}
      values={values}
      onValuesChange={setValues}
      connections={connections}
      onPickPath={onPickPath}
      submitting={session.phase === 'submitting'}
      problems={session.phase === 'invalid' ? session.problems : undefined}
      failureKey={failureKey}
      onSubmit={submit}
      onBack={onLeave}
    />
  )
}
