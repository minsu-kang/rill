import type { Workflow } from '@rill/dsl'
import type { NodeRegistry } from '@rill/nodes-core'
import type { PlanResultBody } from '../types'
import { createNameGuard, replaceWords } from './names'
import { fold } from './normalize'
import { literalsIn } from './redact'

const HIDDEN = '<hidden>'

export interface ScrubInput {
  attachmentTexts: readonly string[]
  userTexts: readonly string[]
  existingWorkflow?: Workflow
  registry: NodeRegistry
}

function textScrubber(input: ScrubInput): (text: string) => string {
  if (input.attachmentTexts.every((text) => text === '')) return (text) => text
  const haystacks = input.attachmentTexts.map(fold)
  const known = [...input.userTexts, ...(input.existingWorkflow === undefined ? [] : [JSON.stringify(input.existingWorkflow)])].map(fold)
  const guard = createNameGuard(input)
  return (text) => {
    let scrubbed = text
    for (const literal of new Set(literalsIn(text))) {
      const folded = fold(literal)
      if (haystacks.some((haystack) => haystack.includes(folded)) && !known.some((text) => text.includes(folded))) {
        scrubbed = scrubbed.replaceAll(literal, HIDDEN)
      }
    }
    return replaceWords(scrubbed, (word) => (guard.hides(word) ? HIDDEN : word))
  }
}

/** Hides what the model said in prose about an attachment: identifiers and links of the attachment, and words only the attachment has. */
export function scrubResultText(body: PlanResultBody, input: ScrubInput): PlanResultBody {
  const scrub = textScrubber(input)
  switch (body.kind) {
    case 'workflow':
      return { ...body, summary: scrub(body.summary) }
    case 'questions':
      return {
        ...body,
        summary: scrub(body.summary),
        questions: body.questions.map((question) => ({
          ...question,
          text: scrub(question.text),
          options: question.options.map(scrub),
          default: scrub(question.default),
        })),
      }
    case 'unsupported':
      return { ...body, reason: scrub(body.reason), nearest: scrub(body.nearest), summary: scrub(body.summary) }
  }
}
