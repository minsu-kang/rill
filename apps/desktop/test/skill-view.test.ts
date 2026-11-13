import { describe, expect, it } from 'vitest'
import { skillDraftOf } from '../src/app/agents/model/skill-draft'
import { INITIAL_SKILL_VIEW, skillSelectionOf, skillViewReducer, type SkillViewState } from '../src/app/agents/model/skill-view'
import { skillFixtures } from '../src/fixtures/skills'

const [receipts, slack] = skillFixtures.few as [(typeof skillFixtures.few)[number], (typeof skillFixtures.few)[number]]
const edit = (state: SkillViewState, id: string | undefined, value: string, base = skillDraftOf(receipts)) => skillViewReducer(state, { type: 'edit', field: 'body', value, base, id })

describe('the edits of the Skills screen belong to the skill they were made on', () => {
  it('pins the selection to the skill that is edited, also when it was only shown because it came first', () => {
    const state = edit(INITIAL_SKILL_VIEW, receipts.id, 'Changed')
    expect(state.selectedId).toBe(receipts.id)
    expect(state.edits).toEqual({ ...skillDraftOf(receipts), body: 'Changed' })
  })

  it('shows the edits on their own skill only', () => {
    const state = edit(INITIAL_SKILL_VIEW, receipts.id, 'Changed')
    expect(skillSelectionOf(state, [receipts, slack])).toMatchObject({ dirty: true, draft: { body: 'Changed' } })
    expect(skillSelectionOf(state, [slack])).toMatchObject({ dirty: false, draft: skillDraftOf(slack), skill: slack })
  })

  it('does not show the edits of a deleted skill as a new skill when the list is empty', () => {
    const state = edit(INITIAL_SKILL_VIEW, receipts.id, 'Changed')
    expect(skillSelectionOf(state, [])).toMatchObject({ creating: true, dirty: false, draft: { name: '', description: '', body: '' } })
  })

  it('does not put the edits of the form for a new skill on a skill that showed up in the list', () => {
    const state = edit(INITIAL_SKILL_VIEW, undefined, 'Draft of a new skill', { name: '', description: '', body: '' })
    expect(skillSelectionOf(state, [])).toMatchObject({ creating: true, dirty: true, draft: { body: 'Draft of a new skill' } })
    expect(skillSelectionOf(state, [receipts])).toMatchObject({ creating: false, dirty: false, skill: receipts, draft: skillDraftOf(receipts) })
  })

  it('keeps the edits of the form for a new skill that was opened on purpose', () => {
    const state = edit(skillViewReducer(INITIAL_SKILL_VIEW, { type: 'create' }), undefined, 'Draft', { name: '', description: '', body: '' })
    expect(skillSelectionOf(state, [receipts])).toMatchObject({ creating: true, dirty: true, draft: { body: 'Draft' } })
  })

  it('starts the next edit of another skill from its own stored text, not from the leftover edits', () => {
    const left = edit(INITIAL_SKILL_VIEW, slack.id, 'Slack draft', skillDraftOf(slack))
    const next = edit(left, receipts.id, 'Receipts draft')
    expect(next.selectedId).toBe(receipts.id)
    expect(next.edits).toEqual({ ...skillDraftOf(receipts), body: 'Receipts draft' })
  })

  it('goes back to clean when an edit puts the stored text back', () => {
    const changed = edit(INITIAL_SKILL_VIEW, receipts.id, 'Changed')
    expect(edit(changed, receipts.id, receipts.body).edits).toBeUndefined()
  })
})
