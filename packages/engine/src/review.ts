export const MAX_CONCURRENT_REVIEWS = 1

export class PlanNotReviewableError extends Error {
  constructor() {
    super('only a plan with a workflow can be reviewed')
    this.name = 'PlanNotReviewableError'
  }
}

export class ReviewBusyError extends Error {
  constructor() {
    super('a review is already running; wait for it to finish')
    this.name = 'ReviewBusyError'
  }
}
