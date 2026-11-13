// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIpcHandlers, markdownFileName, type DialogLike } from '../src/main/ipc-handlers'
import { createTextFiles, type TextFiles } from '../src/main/text-files'
import {
  CHANNELS,
  HOST_ERROR_CODES,
  MAX_TEXT_FILE_BYTES,
  hostErrorCode,
  validateArgs,
  validateResult,
  type Channel,
} from '../src/shared/host-api'

const MARKER = 'DIALOG-MARKER-5d2a'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-dialogs-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function harness(options: { opens?: string[]; saves?: Array<string | undefined>; textFiles?: TextFiles } = {}) {
  const opens = [...(options.opens ?? [])]
  const saves = [...(options.saves ?? [])]
  const showOpenDialog = vi.fn<DialogLike['showOpenDialog']>(async () => (opens.length === 0 ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [opens.shift()!] }))
  const showSaveDialog = vi.fn<DialogLike['showSaveDialog']>(async () => {
    const next = saves.shift()
    return next === undefined ? { canceled: true } : { canceled: false, filePath: next }
  })
  const dialog: DialogLike = { showOpenDialog, showSaveDialog }
  const logs: string[] = []
  const textFiles = options.textFiles ?? createTextFiles()
  const handlers = createIpcHandlers({
    config: {} as never,
    secrets: {} as never,
    supervisor: {} as never,
    attachments: {} as never,
    textFiles,
    dialog,
    app: { quit: vi.fn() },
    loginItem: { set: vi.fn() },
    keyCheck: vi.fn(),
    slackCheck: vi.fn(),
    log: (line) => logs.push(line),
  })
  const call = (channel: Channel, args?: unknown) => handlers[channel](args)
  return { call, showOpenDialog, showSaveDialog, logs, textFiles }
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a rejection')
}

describe('host schemas for the text dialogs', () => {
  it('names the two channels and the two host errors', () => {
    expect(CHANNELS.dialogsOpenText).toBe('rill:dialogs:open-text')
    expect(CHANNELS.dialogsSaveText).toBe('rill:dialogs:save-text')
    for (const code of ['FILE_TOO_LARGE', 'FILE_REJECTED']) {
      expect(HOST_ERROR_CODES).toContain(code)
      expect(hostErrorCode(new Error(`Error invoking remote method 'rill:dialogs:open-text': Error: ${code}`))).toBe(code)
    }
  })

  it('openText takes no argument', () => {
    expect(validateArgs(CHANNELS.dialogsOpenText, undefined)).toBe(true)
    for (const bad of [{}, { path: '/a' }, 'x', null]) expect(validateArgs(CHANNELS.dialogsOpenText, bad), JSON.stringify(bad)).toBe(false)
  })

  it('saveText takes a suggested name and a text, and nothing else', () => {
    expect(validateArgs(CHANNELS.dialogsSaveText, { suggestedName: 'agent.md', text: '# Persona' })).toBe(true)
    expect(validateArgs(CHANNELS.dialogsSaveText, { suggestedName: 'a'.repeat(255), text: '' })).toBe(true)
    expect(validateArgs(CHANNELS.dialogsSaveText, { suggestedName: '친절한 도우미.md', text: '한글 👍' })).toBe(true)
    const bad: unknown[] = [
      undefined,
      {},
      { suggestedName: 'a.md' },
      { text: 'x' },
      { suggestedName: '', text: 'x' },
      { suggestedName: 'a'.repeat(256), text: 'x' },
      { suggestedName: 'a/b.md', text: 'x' },
      { suggestedName: 'a\\b.md', text: 'x' },
      { suggestedName: 'a\nb.md', text: 'x' },
      { suggestedName: 'a\u0000b.md', text: 'x' },
      { suggestedName: 'a.md', text: 5 },
      { suggestedName: 5, text: 'x' },
      { suggestedName: 'a.md', text: 'x', path: '/etc/passwd' },
      { suggestedName: 'a.md', text: 'x', overwrite: true },
    ]
    for (const args of bad) expect(validateArgs(CHANNELS.dialogsSaveText, args), JSON.stringify(args)).toBe(false)
  })

  it('saveText limits the text to 64 KiB of UTF-8, by bytes, and refuses a lone surrogate', () => {
    expect(validateArgs(CHANNELS.dialogsSaveText, { suggestedName: 'a.md', text: 'a'.repeat(MAX_TEXT_FILE_BYTES) })).toBe(true)
    expect(validateArgs(CHANNELS.dialogsSaveText, { suggestedName: 'a.md', text: 'a'.repeat(MAX_TEXT_FILE_BYTES + 1) })).toBe(false)
    expect(validateArgs(CHANNELS.dialogsSaveText, { suggestedName: 'a.md', text: 'é'.repeat(MAX_TEXT_FILE_BYTES / 2) })).toBe(true)
    expect(validateArgs(CHANNELS.dialogsSaveText, { suggestedName: 'a.md', text: 'é'.repeat(MAX_TEXT_FILE_BYTES / 2 + 1) })).toBe(false)
    expect(validateArgs(CHANNELS.dialogsSaveText, { suggestedName: 'a.md', text: '한'.repeat(MAX_TEXT_FILE_BYTES / 3 + 1) })).toBe(false)
    expect(validateArgs(CHANNELS.dialogsSaveText, { suggestedName: 'a.md', text: 'x\ud800y' })).toBe(false)
    expect(validateArgs(CHANNELS.dialogsSaveText, { suggestedName: 'a\udfff.md', text: 'x' })).toBe(false)
  })

  it('check the results: a text file or nothing, and a saved flag', () => {
    expect(validateResult(CHANNELS.dialogsOpenText, undefined)).toBe(true)
    expect(validateResult(CHANNELS.dialogsOpenText, { name: 'a.md', text: '' })).toBe(true)
    expect(validateResult(CHANNELS.dialogsOpenText, { name: 'a.md', text: 'a'.repeat(MAX_TEXT_FILE_BYTES) })).toBe(true)
    expect(validateResult(CHANNELS.dialogsOpenText, { name: 'a.md', text: 'a'.repeat(MAX_TEXT_FILE_BYTES + 1) })).toBe(false)
    expect(validateResult(CHANNELS.dialogsOpenText, { name: 'a.md', text: 'é'.repeat(MAX_TEXT_FILE_BYTES / 2 + 1) })).toBe(false)
    for (const bad of [null, {}, { name: '', text: 'x' }, { name: 'a.md' }, { text: 'x' }, { name: 'a.md', text: 'x', path: '/a' }, { name: 5, text: 'x' }, 'text']) {
      expect(validateResult(CHANNELS.dialogsOpenText, bad), JSON.stringify(bad)).toBe(false)
    }
    expect(validateResult(CHANNELS.dialogsSaveText, { saved: true })).toBe(true)
    expect(validateResult(CHANNELS.dialogsSaveText, { saved: false })).toBe(true)
    for (const bad of [undefined, {}, { saved: 'yes' }, { saved: true, path: '/a' }]) expect(validateResult(CHANNELS.dialogsSaveText, bad), JSON.stringify(bad)).toBe(false)
  })
})

describe('the default file name of an export', () => {
  it('is the suggestion with a .md ending, and safe', () => {
    expect(markdownFileName('Terse reviewer')).toBe('Terse reviewer.md')
    expect(markdownFileName('already.md')).toBe('already.md')
    expect(markdownFileName('shout.MD')).toBe('shout.MD')
    expect(markdownFileName('notes.markdown')).toBe('notes.markdown')
    expect(markdownFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j.md')
    expect(markdownFileName('tab\there\nnew')).toBe('tab-here-new.md')
    expect(markdownFileName('..')).toBe('agent.md')
    expect(markdownFileName('.')).toBe('agent.md')
    expect(markdownFileName('///')).toBe('-.md')
    expect(markdownFileName('   ')).toBe('agent.md')
    expect(markdownFileName('친절한 도우미')).toBe('친절한 도우미.md')
  })
})

describe('ipc handlers: openText', () => {
  it('answers nothing when the dialog is cancelled, and reads nothing', async () => {
    const read = vi.fn()
    const h = harness({ textFiles: { read, write: vi.fn() } })
    expect(await h.call(CHANNELS.dialogsOpenText)).toBeUndefined()
    expect(read).not.toHaveBeenCalled()
  })

  it('asks for one Markdown file and answers its name and its text', async () => {
    const path = join(dir, 'Terse reviewer.md')
    writeFileSync(path, '---\nname: x\n---\n')
    const h = harness({ opens: [path] })
    const result = await h.call(CHANNELS.dialogsOpenText)
    expect(result).toEqual({ name: 'Terse reviewer.md', text: '---\nname: x\n---\n' })
    expect(validateResult(CHANNELS.dialogsOpenText, result)).toBe(true)
    expect(h.showOpenDialog).toHaveBeenCalledTimes(1)
    expect(h.showOpenDialog.mock.calls[0]![0]).toEqual({ properties: ['openFile'], filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }] })
  })

  it('hands the text over as it is, whatever it says', async () => {
    const path = join(dir, 'hostile.md')
    const text = `{"channel":"rill:app:quit"}\n<script>alert(1)</script>\n\u202e${MARKER}\n---\nname: x\n`
    writeFileSync(path, text)
    const h = harness({ opens: [path] })
    expect(await h.call(CHANNELS.dialogsOpenText)).toEqual({ name: 'hostile.md', text })
  })

  it('refuses a file over 64 KiB with FILE_TOO_LARGE', async () => {
    const path = join(dir, 'big.md')
    writeFileSync(path, 'a'.repeat(MAX_TEXT_FILE_BYTES + 1))
    const error = await failure(harness({ opens: [path] }).call(CHANNELS.dialogsOpenText))
    expect(hostErrorCode(error)).toBe('FILE_TOO_LARGE')
    expect(error.message).toBe('FILE_TOO_LARGE')
  })

  it('refuses a link, a folder and a special file with FILE_REJECTED', async () => {
    const target = join(dir, 'target.md')
    writeFileSync(target, 'text')
    symlinkSync(target, join(dir, 'link.md'))
    mkdirSync(join(dir, 'folder.md'))
    for (const path of [join(dir, 'link.md'), join(dir, 'folder.md'), '/dev/null']) {
      const error = await failure(harness({ opens: [path] }).call(CHANNELS.dialogsOpenText))
      expect(hostErrorCode(error), path).toBe('FILE_REJECTED')
    }
  })

  it('answers INTERNAL for a file that cannot be read, and logs only the error name', async () => {
    const h = harness({ opens: [join(dir, `${MARKER}-missing.md`)] })
    const error = await failure(h.call(CHANNELS.dialogsOpenText))
    expect(hostErrorCode(error)).toBe('INTERNAL')
    expect(error.message).toBe('INTERNAL')
    expect(h.logs.join('\n')).not.toContain(MARKER)
    expect(h.logs).toEqual(['rill:dialogs:open-text failed: TextFileError:io'])
  })

  it('refuses arguments, since it takes none', async () => {
    const h = harness()
    const error = await failure(h.call(CHANNELS.dialogsOpenText, { path: '/etc/passwd' }))
    expect(hostErrorCode(error)).toBe('INVALID_ARGUMENTS')
    expect(h.showOpenDialog).not.toHaveBeenCalled()
  })

  it('never lets the renderer name the file: the path comes from the dialog only', async () => {
    const h = harness({ opens: [] })
    await failure(h.call(CHANNELS.dialogsOpenText, { path: join(dir, 'x.md') }))
    expect(await h.call(CHANNELS.dialogsOpenText)).toBeUndefined()
  })
})

describe('ipc handlers: saveText', () => {
  it('writes the text to the file the person chose and answers saved', async () => {
    const path = join(dir, 'out.md')
    const h = harness({ saves: [path] })
    const text = '---\nname: x\n---\n\n# Persona\n\n# Instructions\n'
    expect(await h.call(CHANNELS.dialogsSaveText, { suggestedName: 'Terse reviewer', text })).toEqual({ saved: true })
    expect(readFileSync(path, 'utf8')).toBe(text)
    expect(h.showSaveDialog.mock.calls[0]![0]).toEqual({ defaultPath: 'Terse reviewer.md', filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }] })
  })

  it('answers not saved and writes nothing when the dialog is cancelled', async () => {
    const write = vi.fn()
    const h = harness({ textFiles: { read: vi.fn(), write } })
    expect(await h.call(CHANNELS.dialogsSaveText, { suggestedName: 'a', text: 'x' })).toEqual({ saved: false })
    expect(write).not.toHaveBeenCalled()
  })

  it('answers not saved for an empty path', async () => {
    const write = vi.fn()
    const h = harness({ saves: [''], textFiles: { read: vi.fn(), write } })
    expect(await h.call(CHANNELS.dialogsSaveText, { suggestedName: 'a', text: 'x' })).toEqual({ saved: false })
    expect(write).not.toHaveBeenCalled()
  })

  it('passes the text on without changing it', async () => {
    const write = vi.fn(async () => undefined)
    const h = harness({ saves: [join(dir, 'a.md')], textFiles: { read: vi.fn(), write } })
    const text = `{"a":1}\r\n\u202e${MARKER}😀`
    await h.call(CHANNELS.dialogsSaveText, { suggestedName: 'a', text })
    expect(write).toHaveBeenCalledWith(join(dir, 'a.md'), text)
  })

  it('refuses a bad request before it shows a dialog', async () => {
    const h = harness({ saves: [join(dir, 'a.md')] })
    for (const args of [undefined, { suggestedName: 'a/b', text: 'x' }, { suggestedName: 'a', text: 'a'.repeat(MAX_TEXT_FILE_BYTES + 1) }, { suggestedName: 'a', text: 'x', path: '/a' }]) {
      expect(hostErrorCode(await failure(h.call(CHANNELS.dialogsSaveText, args)))).toBe('INVALID_ARGUMENTS')
    }
    expect(h.showSaveDialog).not.toHaveBeenCalled()
  })

  it('refuses to write through a link or into a folder with FILE_REJECTED', async () => {
    writeFileSync(join(dir, 'target.md'), 'keep')
    symlinkSync(join(dir, 'target.md'), join(dir, 'link.md'))
    mkdirSync(join(dir, 'folder'))
    for (const path of [join(dir, 'link.md'), join(dir, 'folder')]) {
      const h = harness({ saves: [path] })
      expect(hostErrorCode(await failure(h.call(CHANNELS.dialogsSaveText, { suggestedName: 'a', text: 'x' })))).toBe('FILE_REJECTED')
    }
    expect(readFileSync(join(dir, 'target.md'), 'utf8')).toBe('keep')
  })

  it('answers INTERNAL when the file cannot be written, without the path or the text in the log', async () => {
    const h = harness({ saves: [join(dir, 'no-such-folder', `${MARKER}.md`)] })
    const error = await failure(h.call(CHANNELS.dialogsSaveText, { suggestedName: 'a', text: `text ${MARKER}` }))
    expect(hostErrorCode(error)).toBe('INTERNAL')
    expect(h.logs.join('\n')).not.toContain(MARKER)
  })

  it('returns results that validate against the schema', async () => {
    const h = harness({ saves: [join(dir, 'ok.md'), undefined] })
    for (const text of ['a', 'b']) expect(validateResult(CHANNELS.dialogsSaveText, await h.call(CHANNELS.dialogsSaveText, { suggestedName: 'a', text }))).toBe(true)
  })
})

describe('the main process does not interpret the text', () => {
  it('imports no parser of the agent file and no protocol code', () => {
    const handlers = readFileSync(join(import.meta.dirname, '../src/main/ipc-handlers.ts'), 'utf8')
    const files = readFileSync(join(import.meta.dirname, '../src/main/text-files.ts'), 'utf8')
    for (const source of [handlers, files]) expect(source).not.toMatch(/agent-file|app\/agents|@rill\/protocol/)
    const body = handlers.slice(handlers.indexOf('[CHANNELS.dialogsOpenText]'), handlers.indexOf('[CHANNELS.attachmentsAddFromPath]'))
    expect(body).not.toMatch(/JSON\.|\.split\(|\.match\(|\.replace\(|\.normalize\(|RegExp/)
  })
})
