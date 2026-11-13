import { describe, expect, it } from 'vitest'
import { createFakeHost } from '../src/engine/fake-host'
import { createHostApi, type IpcLike } from '../src/preload/host-bridge'
import { CHANNELS, HostError, MAX_TEXT_FILE_BYTES, hostErrorCode } from '../src/shared/host-api'

describe('the fake host: openText', () => {
  it('answers the queued files one after the other, then nothing', async () => {
    const host = createFakeHost({ textPicks: [{ name: 'a.md', text: 'one' }, undefined, { name: 'b.md', text: 'two' }] })
    expect(await host.dialogs.openText()).toEqual({ name: 'a.md', text: 'one' })
    expect(await host.dialogs.openText()).toBeUndefined()
    expect(await host.dialogs.openText()).toEqual({ name: 'b.md', text: 'two' })
    expect(await host.dialogs.openText()).toBeUndefined()
    expect(host.state().textPicks).toEqual([])
  })

  it('throws a queued host error, and FILE_TOO_LARGE for a text over 64 KiB', async () => {
    const host = createFakeHost({ textPicks: [new HostError('FILE_REJECTED'), { name: 'big.md', text: 'a'.repeat(MAX_TEXT_FILE_BYTES + 1) }] })
    expect(hostErrorCode(await host.dialogs.openText().catch((error: unknown) => error))).toBe('FILE_REJECTED')
    expect(hostErrorCode(await host.dialogs.openText().catch((error: unknown) => error))).toBe('FILE_TOO_LARGE')
  })

  it('hands out copies', async () => {
    const pick = { name: 'a.md', text: 'one' }
    const host = createFakeHost({ textPicks: [pick] })
    const result = await host.dialogs.openText()
    pick.text = 'changed'
    expect(result).toEqual({ name: 'a.md', text: 'one' })
  })
})

describe('the fake host: saveText', () => {
  it('keeps what was saved, and answers saved', async () => {
    const host = createFakeHost()
    expect(await host.dialogs.saveText({ suggestedName: 'a.md', text: 'one' })).toEqual({ saved: true })
    expect(host.state().savedTexts).toEqual([{ suggestedName: 'a.md', text: 'one' }])
  })

  it('answers not saved when the person cancels, and keeps nothing', async () => {
    const host = createFakeHost({ saveAnswers: [false, true] })
    expect(await host.dialogs.saveText({ suggestedName: 'a.md', text: 'one' })).toEqual({ saved: false })
    expect(host.state().savedTexts).toEqual([])
    expect(await host.dialogs.saveText({ suggestedName: 'a.md', text: 'two' })).toEqual({ saved: true })
    expect(host.state().savedTexts).toEqual([{ suggestedName: 'a.md', text: 'two' }])
  })

  it('refuses what the real host refuses', async () => {
    const host = createFakeHost()
    const bad = [
      { suggestedName: '', text: 'x' },
      { suggestedName: 'a/b.md', text: 'x' },
      { suggestedName: 'a.md', text: 'a'.repeat(MAX_TEXT_FILE_BYTES + 1) },
      { suggestedName: 'a.md', text: 'x\ud800' },
      { suggestedName: 'a.md', text: 'x', extra: 1 },
    ]
    for (const input of bad) expect(hostErrorCode(await host.dialogs.saveText(input as never).catch((error: unknown) => error))).toBe('INVALID_ARGUMENTS')
    expect(host.state().savedTexts).toEqual([])
  })
})

describe('the preload bridge: the text dialogs', () => {
  function ipc(results: Record<string, unknown>) {
    const calls: Array<[string, ...unknown[]]> = []
    const bridge: IpcLike = {
      invoke: async (channel: string, ...args: unknown[]) => {
        calls.push([channel, ...args])
        const value = results[channel]
        if (value instanceof Error) throw value
        return value
      },
      on: () => undefined,
      removeListener: () => undefined,
    }
    return { bridge, calls }
  }

  it('calls the two channels with the argument shapes of the contract', async () => {
    const { bridge, calls } = ipc({ [CHANNELS.dialogsOpenText]: { name: 'a.md', text: 'x' }, [CHANNELS.dialogsSaveText]: { saved: true } })
    const api = createHostApi(bridge)
    expect(await api.dialogs.openText()).toEqual({ name: 'a.md', text: 'x' })
    expect(await api.dialogs.saveText({ suggestedName: 'a.md', text: 'x' })).toEqual({ saved: true })
    expect(calls).toEqual([[CHANNELS.dialogsOpenText], [CHANNELS.dialogsSaveText, { suggestedName: 'a.md', text: 'x' }]])
  })

  it('passes a cancelled dialog on as nothing', async () => {
    const { bridge } = ipc({ [CHANNELS.dialogsOpenText]: undefined })
    expect(await createHostApi(bridge).dialogs.openText()).toBeUndefined()
  })

  it('refuses a bad save request before it leaves, and an answer that does not fit the contract', async () => {
    const { bridge, calls } = ipc({ [CHANNELS.dialogsOpenText]: { name: 'a.md', text: 'a'.repeat(MAX_TEXT_FILE_BYTES + 1) }, [CHANNELS.dialogsSaveText]: { saved: 'yes' } })
    const api = createHostApi(bridge)
    expect(hostErrorCode(await api.dialogs.saveText({ suggestedName: 'a/b', text: 'x' }).catch((error: unknown) => error))).toBe('INVALID_ARGUMENTS')
    expect(hostErrorCode(await api.dialogs.saveText({ suggestedName: 'a.md', text: 'a'.repeat(MAX_TEXT_FILE_BYTES + 1) }).catch((error: unknown) => error))).toBe('INVALID_ARGUMENTS')
    expect(calls).toEqual([])
    expect(hostErrorCode(await api.dialogs.openText().catch((error: unknown) => error))).toBe('INTERNAL')
    expect(hostErrorCode(await api.dialogs.saveText({ suggestedName: 'a.md', text: 'x' }).catch((error: unknown) => error))).toBe('INTERNAL')
  })

  it('turns a remote error into its host code', async () => {
    const { bridge } = ipc({ [CHANNELS.dialogsOpenText]: new Error("Error invoking remote method 'rill:dialogs:open-text': Error: FILE_TOO_LARGE") })
    expect(hostErrorCode(await createHostApi(bridge).dialogs.openText().catch((error: unknown) => error))).toBe('FILE_TOO_LARGE')
  })
})
