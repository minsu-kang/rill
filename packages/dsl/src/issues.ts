export type IssueStage = 1 | 2 | 3 | 4

export interface PlanIssue {
  stage: IssueStage
  pointer: string
  code: string
  message: string
  hint?: string
}
