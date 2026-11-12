import type { EngineEvent, RunSummary, StepDetail } from '@rill/protocol'
import { useEffect, useState } from 'react'
import { reduceEvent, reduceRunSummary } from '../model/reduce-events'
import { NO_STATES, type RunStates } from '../model/status'
import { statesFromSteps } from '../model/steps'
import type { EngineClient } from './client'

const RUN_LIMIT = 50
const NO_STEPS: StepDetail[] = []
const NO_RUNS: RunSummary[] = []
const REFETCH_ON: ReadonlySet<EngineEvent['type']> = new Set(['step.succeeded', 'step.failed', 'step.continued', 'step.skipped', 'run.finished'])

export interface RunStatesResult {
  run: RunSummary | undefined
  steps: StepDetail[]
  states: RunStates
  error: string | undefined
  loading: boolean
}

export interface RunListResult {
  runs: RunSummary[]
  error: string | undefined
  loading: boolean
}

interface RunData {
  runId: string
  run: RunSummary | undefined
  steps: StepDetail[]
  states: RunStates
  error: string | undefined
}

interface ListData {
  workflowId: string
  runs: RunSummary[]
  error: string | undefined
}

const IDLE_RUN: RunStatesResult = { run: undefined, steps: NO_STEPS, states: NO_STATES, error: undefined, loading: false }
const LOADING_RUN: RunStatesResult = { ...IDLE_RUN, loading: true }
const IDLE_LIST: RunListResult = { runs: NO_RUNS, error: undefined, loading: false }
const LOADING_LIST: RunListResult = { ...IDLE_LIST, loading: true }

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function coalesced(job: () => Promise<void>): () => void {
  let running = false
  let again = false
  return () => {
    if (running) {
      again = true
      return
    }
    running = true
    void (async () => {
      try {
        do {
          again = false
          await job()
        } while (again)
      } finally {
        running = false
      }
    })()
  }
}

function touchesRun(event: EngineEvent, runId: string): boolean {
  return (event.type.startsWith('step.') || event.type.startsWith('run.')) && 'runId' in event && event.runId === runId
}

export function useRunStates(client: EngineClient, runId: string | undefined): RunStatesResult {
  const [data, setData] = useState<RunData | undefined>(undefined)

  useEffect(() => {
    if (runId === undefined) return undefined
    let active = true
    let ready = false
    const buffered: EngineEvent[] = []

    const refresh = coalesced(async () => {
      try {
        const { run, steps } = await client.request('getRun', { runId })
        if (!active) return
        setData((previous) =>
          previous === undefined || previous.runId !== runId
            ? previous
            : {
                ...previous,
                run,
                steps,
                states: previous.error === undefined ? previous.states : statesFromSteps(steps, run.status),
                error: undefined,
              },
        )
      } catch (error) {
        if (!active) return
        setData((previous) => (previous === undefined || previous.runId !== runId ? previous : { ...previous, error: messageOf(error) }))
      }
    })

    const unsubscribe = client.onEvent((event) => {
      if (!touchesRun(event, runId)) return
      if (!ready) {
        buffered.push(event)
        return
      }
      setData((previous) =>
        previous === undefined || previous.runId !== runId
          ? previous
          : {
              ...previous,
              states: reduceEvent(previous.states, event, runId),
              run: previous.run === undefined ? undefined : reduceRunSummary(previous.run, event),
            },
      )
      if (REFETCH_ON.has(event.type)) refresh()
    })

    void (async () => {
      try {
        const first = await client.request('getRun', { runId })
        if (!active) return
        let states = statesFromSteps(first.steps, first.run.status)
        let run = first.run
        for (const event of buffered) {
          if (event.type === 'run.started' && run.status !== 'queued') continue
          states = reduceEvent(states, event, runId)
          run = reduceRunSummary(run, event)
        }
        buffered.length = 0
        ready = true
        setData({ runId, run, steps: first.steps, states, error: undefined })
      } catch (error) {
        if (!active) return
        buffered.length = 0
        ready = true
        setData({ runId, run: undefined, steps: NO_STEPS, states: NO_STATES, error: messageOf(error) })
      }
    })()

    return () => {
      active = false
      unsubscribe()
    }
  }, [client, runId])

  if (runId === undefined) return IDLE_RUN
  if (data === undefined || data.runId !== runId) return LOADING_RUN
  return { run: data.run, steps: data.steps, states: data.states, error: data.error, loading: false }
}

export function useRunList(client: EngineClient, workflowId: string | undefined): RunListResult {
  const [data, setData] = useState<ListData | undefined>(undefined)

  useEffect(() => {
    if (workflowId === undefined) return undefined
    let active = true

    const load = coalesced(async () => {
      try {
        const { runs } = await client.request('listRuns', { workflowId, limit: RUN_LIMIT })
        if (active) setData({ workflowId, runs, error: undefined })
      } catch (error) {
        if (active) setData((previous) => ({ workflowId, runs: previous?.workflowId === workflowId ? previous.runs : NO_RUNS, error: messageOf(error) }))
      }
    })

    const unsubscribe = client.onEvent((event) => {
      const started = (event.type === 'run.started' || event.type === 'trigger.fired') && event.workflowId === workflowId
      if (started || event.type === 'run.finished') load()
    })
    load()

    return () => {
      active = false
      unsubscribe()
    }
  }, [client, workflowId])

  if (workflowId === undefined) return IDLE_LIST
  if (data === undefined || data.workflowId !== workflowId) return LOADING_LIST
  return { runs: data.runs, error: data.error, loading: false }
}
