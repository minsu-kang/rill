import { describe, expect, it } from 'vitest'
import { EventBus, type EngineEvent } from '../src/events'

describe('EventBus', () => {
  it('stamps events with the clock and delivers them in order', () => {
    const bus = new EventBus(() => 42)
    const seen: EngineEvent[] = []
    bus.on((event) => seen.push(event))
    bus.emit({ type: 'workflow.activated', workflowId: 'w' })
    bus.emit({ type: 'workflow.deactivated', workflowId: 'w' })
    expect(seen).toEqual([
      { type: 'workflow.activated', workflowId: 'w', at: 42 },
      { type: 'workflow.deactivated', workflowId: 'w', at: 42 },
    ])
  })

  it('stops delivering after unsubscribe', () => {
    const bus = new EventBus(() => 1)
    const seen: string[] = []
    const off = bus.on((event) => seen.push(event.type))
    bus.emit({ type: 'workflow.activated', workflowId: 'w' })
    off()
    bus.emit({ type: 'workflow.deactivated', workflowId: 'w' })
    expect(seen).toEqual(['workflow.activated'])
  })

  it('keeps delivering to other listeners when one throws', () => {
    const bus = new EventBus(() => 1)
    const seen: string[] = []
    bus.on(() => {
      throw new Error('bad listener')
    })
    bus.on((event) => seen.push(event.type))
    expect(() => bus.emit({ type: 'workflow.activated', workflowId: 'w' })).not.toThrow()
    expect(seen).toEqual(['workflow.activated'])
  })

  it('lets a listener unsubscribe while an event is being delivered', () => {
    const bus = new EventBus(() => 1)
    const seen: string[] = []
    const off = bus.on(() => off())
    bus.on((event) => seen.push(event.type))
    bus.emit({ type: 'workflow.activated', workflowId: 'w' })
    bus.emit({ type: 'workflow.deactivated', workflowId: 'w' })
    expect(seen).toEqual(['workflow.activated', 'workflow.deactivated'])
  })
})
