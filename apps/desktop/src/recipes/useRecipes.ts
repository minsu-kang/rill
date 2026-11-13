import type { RecipeDraft, RecipeInfo, RecipeValues } from '@rill/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { EngineClient } from '../engine/client'
import type { MessageKey } from '../i18n'
import { isRuleMessage } from '../model/rules'

export type RecipeListStatus = 'loading' | 'ready' | 'error'

export interface RecipeListResult {
  status: RecipeListStatus
  recipes: readonly RecipeInfo[]
  reload(): void
}

interface Loaded {
  attempt: number
  recipes: readonly RecipeInfo[]
  failed: boolean
}

const NO_RECIPES: readonly RecipeInfo[] = []

export function useRecipeList(client: EngineClient): RecipeListResult {
  const [attempt, setAttempt] = useState(0)
  const [data, setData] = useState<Loaded | undefined>(undefined)

  useEffect(() => {
    let active = true
    client.request('listRecipes', {}).then(
      ({ recipes }) => {
        if (active) setData({ attempt, recipes, failed: false })
      },
      () => {
        if (active) setData({ attempt, recipes: NO_RECIPES, failed: true })
      },
    )
    return () => {
      active = false
    }
  }, [client, attempt])

  const reload = useCallback(() => setAttempt((previous) => previous + 1), [])
  if (data === undefined || data.attempt !== attempt) return { status: 'loading', recipes: NO_RECIPES, reload }
  return { status: data.failed ? 'error' : 'ready', recipes: data.recipes, reload }
}

export type DeployView =
  | { phase: 'idle' }
  | { phase: 'deploying' }
  | { phase: 'deployed'; workflowId: string }
  | { phase: 'failed'; key: MessageKey }

export type RecipeSession =
  | { phase: 'editing' }
  | { phase: 'submitting' }
  | { phase: 'invalid'; problems: string[] }
  | { phase: 'failed'; key: MessageKey }
  | { phase: 'draft'; draft: RecipeDraft; deploy: DeployView }

export interface RecipeSessionControls {
  session: RecipeSession
  submit(values: RecipeValues): void
  deploy(): void
  edit(): void
}

const SUBMIT_ERRORS: Readonly<Record<string, MessageKey>> = Object.freeze({
  NOT_FOUND: 'recipes.error.notFound',
  INVALID_PARAMS: 'recipes.error.params',
})

const DEPLOY_ERRORS: Readonly<Record<string, MessageKey>> = Object.freeze({
  INVALID_WORKFLOW: 'recipes.deployError.invalid',
})

function codeOf(error: unknown): string | undefined {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  return typeof code === 'string' ? code : undefined
}

function problemsOf(error: unknown): string[] {
  const problems = typeof error === 'object' && error !== null && 'problems' in error ? error.problems : undefined
  return Array.isArray(problems) ? problems.filter((problem): problem is string => typeof problem === 'string') : []
}

function deployErrorKey(error: unknown): MessageKey {
  if (codeOf(error) === 'INVALID_WORKFLOW' && problemsOf(error).some(isRuleMessage)) return 'recipes.deployError.rule'
  return keyFor(DEPLOY_ERRORS, error, 'recipes.deployError.generic')
}

function keyFor(table: Readonly<Record<string, MessageKey>>, error: unknown, fallback: MessageKey): MessageKey {
  const code = codeOf(error)
  return code !== undefined && Object.hasOwn(table, code) ? table[code]! : fallback
}

export function useRecipeSession(client: EngineClient, recipeId: string, onDeployed?: (workflowId: string) => void): RecipeSessionControls {
  const [session, setSession] = useState<RecipeSession>({ phase: 'editing' })
  const busy = useRef(false)
  const alive = useRef(false)
  const notify = useRef(onDeployed)

  useEffect(() => {
    notify.current = onDeployed
  }, [onDeployed])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const submit = useCallback(
    (values: RecipeValues) => {
      if (busy.current) return
      busy.current = true
      setSession({ phase: 'submitting' })
      client.request('instantiateRecipe', { recipeId, values }).then(
        (draft) => {
          busy.current = false
          if (alive.current) setSession({ phase: 'draft', draft, deploy: { phase: 'idle' } })
        },
        (error: unknown) => {
          busy.current = false
          if (!alive.current) return
          if (codeOf(error) === 'RECIPE_INVALID') setSession({ phase: 'invalid', problems: problemsOf(error) })
          else setSession({ phase: 'failed', key: keyFor(SUBMIT_ERRORS, error, 'recipes.error.generic') })
        },
      )
    },
    [client, recipeId],
  )

  const deploy = useCallback(() => {
    if (busy.current || session.phase !== 'draft' || session.deploy.phase === 'deploying' || session.deploy.phase === 'deployed') return
    busy.current = true
    const { draft } = session
    setSession({ phase: 'draft', draft, deploy: { phase: 'deploying' } })
    client.request('deploy', { workflow: draft.workflow }).then(
      ({ workflowId }) => {
        busy.current = false
        if (!alive.current) return
        setSession({ phase: 'draft', draft, deploy: { phase: 'deployed', workflowId } })
        notify.current?.(workflowId)
      },
      (error: unknown) => {
        busy.current = false
        if (alive.current) setSession({ phase: 'draft', draft, deploy: { phase: 'failed', key: deployErrorKey(error) } })
      },
    )
  }, [client, session])

  const edit = useCallback(() => {
    if (busy.current) return
    setSession({ phase: 'editing' })
  }, [])

  return { session, submit, deploy, edit }
}
