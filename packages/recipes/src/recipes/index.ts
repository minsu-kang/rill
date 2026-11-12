import type { Recipe } from '../types'
import { dailyHealthCheck } from './daily-health-check'
import { failureWebhookAlert } from './failure-webhook-alert'
import { monthlyReminder } from './monthly-reminder'
import { receiptBigAmountAlert } from './receipt-big-amount-alert'
import { receiptFolderToCsv } from './receipt-folder-to-csv'
import { webhookToSlack } from './webhook-to-slack'

export const RECIPES: readonly Recipe[] = [
  receiptFolderToCsv,
  receiptBigAmountAlert,
  dailyHealthCheck,
  webhookToSlack,
  monthlyReminder,
  failureWebhookAlert,
]

export function findRecipe(id: string): Recipe | undefined {
  return RECIPES.find((recipe) => recipe.id === id)
}
