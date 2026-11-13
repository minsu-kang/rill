// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.doUnmock('@rill/protocol')
  vi.resetModules()
})

describe('the agent limit in the error texts', () => {
  it('is the limit of the protocol, in both languages', async () => {
    vi.resetModules()
    vi.doMock('@rill/protocol', async (original) => ({ ...(await original<typeof import('@rill/protocol')>()), AGENT_MAX_ITEMS: 7 }))
    const { chatEn } = await import('../src/i18n/chat.en')
    const { chatKo } = await import('../src/i18n/chat.ko')
    expect(chatEn['chat.error.AGENT_FULL']).toContain('7')
    expect(chatEn['chat.error.AGENT_FULL']).not.toContain('12')
    expect(chatKo['chat.error.AGENT_FULL']).toContain('7')
    expect(chatKo['chat.error.AGENT_FULL']).not.toContain('12')
  })

  it('says 12 with the limit of today', async () => {
    const { AGENT_MAX_ITEMS } = await import('@rill/protocol')
    const { chatEn } = await import('../src/i18n/chat.en')
    const { chatKo } = await import('../src/i18n/chat.ko')
    expect(chatEn['chat.error.AGENT_FULL']).toBe(`At most ${AGENT_MAX_ITEMS} agents can be saved. Delete one first.`)
    expect(chatKo['chat.error.AGENT_FULL']).toBe(`에이전트는 ${AGENT_MAX_ITEMS}개까지 저장할 수 있어요. 하나를 지운 뒤에 저장해 주세요.`)
  })
})

describe('the name of the built-in agent', () => {
  it('is reserved in every language, so that no saved agent shares the label of the Default entry', async () => {
    const { AGENT_BUILTIN_NAMES, isReservedAgentName } = await import('@rill/protocol')
    const { en } = await import('../src/i18n/en')
    const { ko } = await import('../src/i18n/ko')
    for (const dictionary of [en, ko]) expect(isReservedAgentName(dictionary['agents.default.name'])).toBe(true)
    expect(AGENT_BUILTIN_NAMES).toHaveLength(2)
  })
})
