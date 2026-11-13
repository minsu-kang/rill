import { skillNameKey, type Agent, type Skill, type SkillFields } from '@rill/protocol'
import { useSyncExternalStore } from 'react'
import { agentsStoreFor, errorCodeOf, skillIdsOf } from './agents'
import type { EngineClient } from './client'

export interface SkillsState {
  status: 'loading' | 'ready' | 'error'
  skills: readonly Skill[]
  error?: unknown
}

export interface SkillsStore {
  getState(): SkillsState
  subscribe(listener: () => void): () => void
  watch(listener: () => void): () => void
  refresh(): Promise<void>
  save(input: SkillFields & { id?: string }): Promise<Skill>
  remove(id: string): Promise<boolean>
}

const INITIAL: SkillsState = { status: 'loading', skills: [] }

function byName(skills: readonly Skill[]): Skill[] {
  return [...skills].sort((a, b) => (skillNameKey(a.name) < skillNameKey(b.name) ? -1 : skillNameKey(a.name) > skillNameKey(b.name) ? 1 : 0))
}

export function skillSize(skill: Pick<Skill, 'body'>): number {
  return [...skill.body].length
}

export function agentsUsingSkill(agents: readonly Agent[], skillId: string): Agent[] {
  return agents.filter((agent) => skillIdsOf(agent).includes(skillId))
}

function createSkillsStore(client: EngineClient): SkillsStore {
  let state: SkillsState = INITIAL
  let started = false
  let generation = 0
  let tail: Promise<unknown> = Promise.resolve()
  const listeners = new Set<() => void>()

  function set(next: SkillsState): void {
    state = next
    for (const listener of [...listeners]) listener()
  }

  function load(): Promise<void> {
    generation += 1
    const mine = generation
    return client.request('listSkills', {}).then(
      (result) => {
        if (mine === generation) set({ status: 'ready', skills: result.skills })
      },
      (error: unknown) => {
        if (mine === generation) set({ ...state, status: 'error', error })
      },
    )
  }

  function applied(skills: readonly Skill[]): void {
    generation += 1
    if (state.status === 'ready' || state.skills.length > 0) {
      set({ status: 'ready', skills })
      return
    }
    set({ ...state, skills })
    void load()
  }

  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = tail.then(job, job).catch((error: unknown) => {
      if (errorCodeOf(error) === 'SKILL_NOT_FOUND') void load()
      throw error
    })
    tail = run.catch(() => undefined)
    return run
  }

  function watch(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  return {
    getState: () => state,
    watch,
    subscribe(listener) {
      const stop = watch(listener)
      if (!started) {
        started = true
        void load()
      }
      return stop
    },
    refresh() {
      started = true
      if (state.status === 'error') set({ ...state, status: 'loading' })
      return load()
    },
    save: (input) =>
      enqueue(async () => {
        const { skill } = await client.request('saveSkill', input)
        applied(byName([...state.skills.filter((entry) => entry.id !== skill.id), skill]))
        return skill
      }),
    remove: (id) =>
      enqueue(async () => {
        const { deleted } = await client.request('deleteSkill', { id })
        applied(state.skills.filter((entry) => entry.id !== id))
        if (deleted) await agentsStoreFor(client).refresh()
        return deleted
      }),
  }
}

const STORES = new WeakMap<object, SkillsStore>()

export function skillsStoreFor(client: EngineClient): SkillsStore {
  const known = STORES.get(client)
  if (known !== undefined) return known
  const created = createSkillsStore(client)
  STORES.set(client, created)
  return created
}

export function useSkills(client: EngineClient): { state: SkillsState; store: SkillsStore } {
  const store = skillsStoreFor(client)
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState)
  return { state, store }
}
