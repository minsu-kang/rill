// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(import.meta.dirname, '../src')

const BUSY = /busy|submitting|running|pending|saving|checking|working|asking|loading|deploying|planning|restarting|waiting|connecting/i
const DISABLED = /\bdisabled=\{([^}]*)\}/g
const HOOK = /\b(useAction|useKeepFocus)\(/
const IMPORTS_HOOK = /import\s*\{[^}]*\b(useAction|useKeepFocus)\b[^}]*\}\s*from/

function disablesWhileBusy(text: string): boolean {
  return [...text.matchAll(DISABLED)].some((match) => BUSY.test(match[1]!))
}

function usesFocusHook(text: string): boolean {
  return HOOK.test(text) && IMPORTS_HOOK.test(text)
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
})
