// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(import.meta.dirname, '../src')

const WORDS = [
  'busy',
  'submitting',
  'running',
  'pending',
  'saving',
  'checking',
  'working',
  'asking',
  'loading',
  'deploying',
  'planning',
  'restarting',
  'waiting',
  'connecting',
  'deleting',
  'removing',
  'sending',
  'importing',
  'exporting',
  'uploading',
  'confirming',
]
const capitalized = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1)
const BUSY = new RegExp(WORDS.map((word) => `(?<![A-Za-z])${word}|(?<=[a-z0-9_])${capitalized(word)}`).join('|'))
const HOOK = /\b(useAction|useKeepFocus)\(/
const IMPORTS_HOOK = /import\s*\{[^}]*\b(useAction|useKeepFocus)\b[^}]*\}\s*from/
const STATE_FLAG = /const\s*\[(\w+),\s*set\w+\]\s*=\s*useState\b/g

function propExpressions(text: string, prop: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(new RegExp(`(?<![-\\w])${prop}=\\{`, 'g'))) {
    const begin = match.index + match[0].length
    let depth = 1
    let end = begin
    while (end < text.length && depth > 0) {
      const char = text[end]
      if (char === '{') depth += 1
      else if (char === '}') depth -= 1
      end += 1
    }
    found.push(text.slice(begin, end - 1))
  }
  return found
}

function guardedExpressions(text: string): string[] {
  return [...propExpressions(text, 'disabled'), ...propExpressions(text, 'busy')]
}

function disablesWhileBusy(text: string): boolean {
  return guardedExpressions(text).some((expression) => BUSY.test(expression))
}

function usesFocusHook(text: string): boolean {
  return HOOK.test(text) && IMPORTS_HOOK.test(text)
}

function flagsWithoutHook(text: string): string[] {
  const expressions = guardedExpressions(text)
  const flags = [...text.matchAll(STATE_FLAG)].map((match) => match[1]!).filter((name) => BUSY.test(name))
  return flags.filter((name) => {
    const reaches = expressions.some((expression) => new RegExp(`\\b${name}\\b`).test(expression))
    const covered = IMPORTS_HOOK.test(text) && new RegExp(`\\buseKeepFocus\\([^)]*\\b${name}\\b`).test(text)
    return reaches && !covered
  })
}

const CONFIRM_HOLDERS = [
  'app/settings/OAuthCard.tsx',
  'app/settings/ConnectionsSection.tsx',
  'app/workflows/WorkflowActions.tsx',
  'app/agents/RulesScreen.tsx',
  'app/agents/SkillsScreen.tsx',
  'app/agents/AgentsScreen.tsx',
  'app/agents/HooksScreen.tsx',
]

const EXCEPTIONS: Readonly<Record<string, { holders: readonly string[]; reason: string }>> = {
  'app/workflows/ConfirmDialog.tsx': {
    holders: CONFIRM_HOLDERS,
    reason: 'receives busy from the screen that runs the action; the screen keeps the focus on the confirm button when the action fails and the dialog stays, and the modal returns the focus to its opener when the dialog closes',
  },
  'app/workflows/PayloadDialog.tsx': {
    holders: ['app/workflows/WorkflowActions.tsx'],
    reason: 'receives busy from WorkflowActions, which keeps the focus on the submit button when the run fails and the dialog stays',
  },
  'app/agents/AgentEditor.tsx': { holders: ['app/agents/AgentsScreen.tsx'], reason: 'receives busy from AgentsScreen, which runs every action of the editor' },
  'app/agents/AgentImportReview.tsx': { holders: ['app/agents/AgentsScreen.tsx'], reason: 'receives busy from AgentsScreen, which runs the save of the review' },
  'app/agents/SkillEditor.tsx': { holders: ['app/agents/SkillsScreen.tsx'], reason: 'receives busy from SkillsScreen, which runs every action of the editor' },
  'app/agents/SkillImportReview.tsx': { holders: ['app/agents/SkillsScreen.tsx'], reason: 'receives busy from SkillsScreen, which runs the save of the review' },
  'app/agents/HookEditor.tsx': { holders: ['app/agents/HooksScreen.tsx'], reason: 'receives busy from HooksScreen, which runs the save of the form' },
  'chat/Conversation.tsx': {
    holders: ['chat/Composer.tsx'],
    reason: 'planning disables the question card, which stays disabled after the answer because it is no longer the last entry, and the Composer, which calls the hook and moves the focus to the text field when the plan is done',
  },
}

function sourceFiles(dir: string = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx$/.test(entry.name) && !/\.stories\.tsx$/.test(entry.name) ? [path] : []
  })
}

const read = (name: string): string => readFileSync(join(SRC, name), 'utf8')
const names = sourceFiles().map((file) => relative(SRC, file))
const busyFiles = names.filter((name) => disablesWhileBusy(read(name)))

describe('the focus rule for controls that are disabled while an action runs', () => {
  it('finds the files it is meant to guard', () => {
    expect(names.length).toBeGreaterThan(50)
    expect(busyFiles.length).toBeGreaterThan(15)
    for (const name of ['app/settings/KeysSection.tsx', 'recipes/RecipeForm.tsx', 'chat/MemoryPanel.tsx', 'chat/Composer.tsx']) expect(busyFiles).toContain(name)
  })

  it('has a file that disables a control with a busy flag call useAction or useKeepFocus, or sit on the exception list', () => {
    const missing = busyFiles.filter((name) => !usesFocusHook(read(name)) && EXCEPTIONS[name] === undefined)
    expect(missing).toEqual([])
  })

  it('keeps each exception honest: the file still disables a control with a busy flag, still lacks the hook, and every holder uses it', () => {
    const stale: string[] = []
    for (const [name, { holders, reason }] of Object.entries(EXCEPTIONS)) {
      if (reason.trim() === '' || holders.length === 0) stale.push(`${name}: no reason or no holder`)
      if (!busyFiles.includes(name)) stale.push(`${name}: no busy control any more`)
      else if (usesFocusHook(read(name))) stale.push(`${name}: uses the hook itself`)
      for (const holder of holders) if (!usesFocusHook(read(holder))) stale.push(`${name}: holder ${holder} does not use the hook`)
    }
    expect(stale).toEqual([])
  })

  it('has a file whose busy-named state flag reaches a disabled or busy prop pass that flag to useKeepFocus', () => {
    const unguarded = names.flatMap((name) => flagsWithoutHook(read(name)).map((flag) => `${name}: ${flag}`))
    expect(unguarded).toEqual([])
  })

  it('tells a covered file from a new case', () => {
    const control = '<button type="button" disabled={saving} onClick={save}>save</button>'
    const hook = "import { useKeepFocus } from '../ui/useKeepFocus'\n"
    expect(disablesWhileBusy(control)).toBe(true)
    expect(disablesWhileBusy('<button disabled={!ready || action.busy} />')).toBe(true)
    expect(disablesWhileBusy("<button disabled={deploy.phase === 'deploying'} />")).toBe(true)
    expect(disablesWhileBusy('<button disabled={full} />')).toBe(false)
    expect(usesFocusHook(control)).toBe(false)
    expect(usesFocusHook(`${hook}useKeepFocus(saving)\n${control}`)).toBe(true)
    expect(usesFocusHook(`${hook}${control}`)).toBe(false)
    expect(usesFocusHook("import { useAction } from './useAction'\nconst action = useAction()\n")).toBe(true)
  })

  it('sees the controls that the first version of the scan missed', () => {
    expect(disablesWhileBusy('<ConfirmDialog busy={removing} />')).toBe(true)
    expect(disablesWhileBusy('<button disabled={check({ a }) || saving} />')).toBe(true)
    expect(disablesWhileBusy('<button\n  disabled={\n    ready &&\n    {}.x === isSaving\n  }\n/>')).toBe(true)
    for (const flag of ['deleting', 'sending', 'removing', 'importing', 'exporting', 'uploading', 'confirming', 'isDeleting', 'sendingNow']) {
      expect(disablesWhileBusy(`<button disabled={${flag}} />`), flag).toBe(true)
    }
  })

  it('does not take a name that only contains a busy word, or another attribute, for a busy control', () => {
    expect(disablesWhileBusy('<input disabled={masking} />')).toBe(false)
    expect(disablesWhileBusy('<button aria-disabled={busy} />')).toBe(false)
    expect(disablesWhileBusy('<div aria-busy={loading} />')).toBe(false)
    expect(disablesWhileBusy('<button disabled={bypassing} />')).toBe(false)
    expect(disablesWhileBusy('<button disabled={ready && !full} />')).toBe(false)
  })

  it('finds a busy state flag that reaches a control without useKeepFocus', () => {
    const state = "import { useAction } from './useAction'\nconst action = useAction()\nconst [checking, setChecking] = useState(false)\n"
    expect(flagsWithoutHook(`${state}<button disabled={checking} />`)).toEqual(['checking'])
    expect(flagsWithoutHook(`${state}<ConfirmDialog busy={checking} />`)).toEqual(['checking'])
    expect(flagsWithoutHook(`${state}<button disabled={action.busy} />`)).toEqual([])
    expect(flagsWithoutHook("const [open, setOpen] = useState(false)\n<button disabled={open} />")).toEqual([])
    const hook = "import { useKeepFocus } from '../ui/useKeepFocus'\n"
    expect(flagsWithoutHook(`${hook}${state}useKeepFocus(checking || action.busy)\n<button disabled={checking} />`)).toEqual([])
    expect(flagsWithoutHook(`${hook}${state}useKeepFocus(other)\n<button disabled={checking} />`)).toEqual(['checking'])
  })
})
