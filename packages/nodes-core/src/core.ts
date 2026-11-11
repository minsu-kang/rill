import { NodeRegistry } from './registry'
import { condition } from './nodes/condition'
import { csvAppend } from './nodes/csv-append'
import { delay } from './nodes/delay'
import { fileRead } from './nodes/file-read'
import { httpRequest } from './nodes/http-request'
import { notifySlack } from './nodes/notify-slack'
import { transform } from './nodes/transform'
import { triggerCron } from './nodes/trigger-cron'
import { triggerFolderWatch } from './nodes/trigger-folder-watch'
import { triggerManual } from './nodes/trigger-manual'
import { triggerWebhook } from './nodes/trigger-webhook'

export function createCoreRegistry(): NodeRegistry {
  return new NodeRegistry()
    .register(triggerManual)
    .register(triggerCron)
    .register(triggerFolderWatch)
    .register(triggerWebhook)
    .register(transform)
    .register(csvAppend)
    .register(condition)
    .register(delay)
    .register(fileRead)
    .register(httpRequest)
    .register(notifySlack)
}
