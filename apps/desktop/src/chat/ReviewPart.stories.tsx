import type { Meta, StoryObj } from '@storybook/react-vite'
import { useEffect, useState } from 'react'
import { agentFixtures } from '../fixtures/agents'
import { reviewCases, reviewResultOf } from '../fixtures/review'
import type { ReviewState } from './model/review'
import { ReviewPart, type ReviewPartProps } from './ReviewPart'

const meta = { title: 'Chat/ReviewPart', component: ReviewPart } satisfies Meta<typeof ReviewPart>
export default meta
type Story = StoryObj<typeof meta>

const [safety, koReviewer] = agentFixtures.reviewers as [(typeof agentFixtures.reviewers)[0], (typeof agentFixtures.reviewers)[1]]
const one = [{ id: safety.id, name: safety.name, sendsText: true }]
const two = [...one, { id: koReviewer.id, name: koReviewer.name, sendsText: true }]
const bare = [{ id: 'agent-bare', name: 'Bare reviewer', sendsText: false }]

const base: ReviewPartProps = {
  reviewers: one,
  agents: 'ready',
  state: { phase: 'idle' },
  deployed: false,
  onAsk: () => undefined,
  onCancel: () => undefined,
  onClose: () => undefined,
}

const frame = (overrides: Partial<ReviewPartProps>): Story => ({
  args: { ...base, ...overrides },
  render: (given) => (
    <div style={{ width: 460, padding: 'var(--space-4)' }}>
      <ReviewPart {...given} />
    </div>
  ),
})

const done = (result = reviewResultOf(reviewCases.mixed), agentId = safety.id, agentSent = true): ReviewState => ({ phase: 'done', agentId, result, agentSent })
const failed = (key: Extract<ReviewState, { phase: 'error' }>['key']): ReviewState => ({ phase: 'error', agentId: safety.id, key })

export const NoReviewerAgent: Story = frame({ reviewers: [] })

export const AgentsLoading: Story = frame({ reviewers: [], agents: 'loading' })

export const AgentsNotLoaded: Story = frame({ reviewers: [], agents: 'error' })

export const OneReviewer: Story = frame({})

export const ReviewerWithoutSettings: Story = frame({ reviewers: bare })

export const SeveralReviewers: Story = frame({ reviewers: two })

export const PlanDeployed: Story = frame({ deployed: true })

export const Asking: Story = frame({ state: { phase: 'asking', agentId: safety.id, requestId: 1 } })

export const AnswerWithFindings: Story = frame({ state: done() })

export const AnswerNothingFound: Story = frame({ reviewers: two, state: done(reviewResultOf(reviewCases.clean, { agentUsed: { id: koReviewer.id, name: koReviewer.name }, skillsUsed: 0 }), koReviewer.id) })

export const AnswerOfAReviewerWithoutSettings: Story = frame({ reviewers: bare, state: done(reviewResultOf(reviewCases.mixed, { agentUsed: { id: 'agent-bare', name: 'Bare reviewer' }, skillsUsed: 0 }), 'agent-bare', false) })

export const AnswerOnlyNotes: Story = frame({ state: done(reviewResultOf(reviewCases.onlyNotes)) })

export const AnswerWithTenFindings: Story = frame({ state: done(reviewResultOf(reviewCases.many)) })

export const AnswerOnADeployedPlan: Story = frame({ deployed: true, state: done() })

export const AnswerHostileText: Story = {
  name: 'Answer with hostile text',
  ...frame({ state: done(reviewResultOf(reviewCases.hostile, { agentUsed: { id: 'x', name: '<b>Evil reviewer</b>' } })) }),
}

export const ErrorBusy: Story = frame({ state: failed('chat.review.error.busy') })

export const ErrorProvider: Story = frame({ state: failed('chat.review.error.provider') })

export const ErrorProviderMissing: Story = frame({ state: failed('chat.review.error.llmUnavailable') })

export const ErrorInvalidAnswer: Story = frame({ state: failed('chat.review.error.invalid') })

export const ErrorLostConnection: Story = frame({ state: failed('chat.review.error.connection') })

export const ErrorReviewerGone: Story = frame({ reviewers: two, state: failed('chat.review.error.agentNotFound') })

export const ErrorNotAReviewer: Story = frame({ reviewers: two, state: failed('chat.review.error.notReviewer') })

export const ErrorPlanNotFound: Story = frame({ state: failed('chat.review.error.notFound') })

export const ErrorNotReviewable: Story = frame({ state: failed('chat.review.error.notReviewable') })

export const ErrorInvalidParams: Story = frame({ state: failed('chat.review.error.params') })

export const ErrorOther: Story = frame({ state: failed('chat.review.error.generic') })

function Flow() {
  const [state, setState] = useState<ReviewState>({ phase: 'idle' })
  useEffect(() => {
    if (state.phase !== 'asking') return undefined
    const timer = setTimeout(() => setState({ phase: 'done', agentId: state.agentId, result: reviewResultOf(reviewCases.mixed) }), 1500)
    return () => clearTimeout(timer)
  }, [state])
  return (
    <div style={{ width: 460, padding: 'var(--space-4)' }}>
      <ReviewPart
        {...base}
        reviewers={two}
        state={state}
        onAsk={(agentId) => setState({ phase: 'asking', agentId, requestId: 1 })}
        onCancel={() => setState({ phase: 'idle' })}
        onClose={() => setState({ phase: 'idle' })}
      />
    </div>
  )
}

export const AskCancelAndAskAgain: Story = { name: 'Ask, cancel, ask again', args: base, render: () => <Flow /> }
