import type { PlanIssue } from '@rill/dsl'
import { RULE_MAX_ITEMS, type Rule, type RuleKind } from '@rill/protocol'
import type { RuleViolation } from '../model/rules'
import { FIXTURE_NOW } from './runs'

export function ruleOf(id: string, kind: RuleKind, value: string, minutesAgo = 0): Rule {
  return { id, kind, value, createdAt: FIXTURE_NOW - minutesAgo * 60_000 }
}

const some: Rule[] = [
  ruleOf('rule-node-1', 'forbidNode', 'http.request', 50),
  ruleOf('rule-node-2', 'forbidNode', 'notify.slack', 40),
  ruleOf('rule-host-1', 'allowHost', 'api.example.com', 30),
  ruleOf('rule-host-2', 'allowHost', '*.internal.example.org', 20),
  ruleOf('rule-host-3', 'allowHost', '127.0.0.1', 10),
  ruleOf('rule-cap', 'maxPlanEffort', 'high', 5),
]

const oneHost: Rule[] = [ruleOf('rule-host-1', 'allowHost', 'api.example.com', 30)]

const capOnly: Rule[] = [ruleOf('rule-cap', 'maxPlanEffort', 'medium', 5)]

const full: Rule[] = [
  ruleOf('rule-cap', 'maxPlanEffort', 'high', 60),
  ruleOf('rule-node-1', 'forbidNode', 'http.request', 59),
  ruleOf('rule-node-2', 'forbidNode', 'notify.slack', 58),
  ...Array.from({ length: RULE_MAX_ITEMS - 3 }, (_, index) => ruleOf(`rule-host-${index + 1}`, 'allowHost', `host-${String(index + 1).padStart(2, '0')}.example.com`, 50 - index)),
]

export const ruleFixtures = { some, oneHost, capOnly, full }

function issue(pointer: string, message: string): PlanIssue {
  return { stage: 3, pointer, code: 'rule_violation', message }
}

const one: RuleViolation[] = [{ workflowId: 'wf-webhook', name: 'Order webhook to Slack', issues: [issue('/nodes/1/type', 'node forward: the node type http.request is forbidden by the rules')] }]

const several: RuleViolation[] = [
  ...one,
  {
    workflowId: 'wf-health',
    name: 'Daily health check',
    issues: [
      issue('/nodes/1/type', 'node check: the node type http.request is forbidden by the rules'),
      issue('/nodes/4/type', 'node alert: the node type notify.slack is forbidden by the rules'),
    ],
  },
  { workflowId: 'wf-hosts', name: '월간 보고서', issues: [issue('/nodes/2/config/url', 'node send: the host collector.example.net is not in the allowed hosts')] },
  { workflowId: 'wf-template', name: 'Forward the order', issues: [issue('/nodes/2/config/url', 'node send: the host of this URL is only known at run time; with allowed hosts set, write the host into the URL')] },
]

const manyIssues: RuleViolation[] = [
  {
    workflowId: 'wf-many',
    name: 'Nightly export with many steps',
    issues: Array.from({ length: 20 }, (_, index) => issue(`/nodes/${index + 1}/type`, `node step${index + 1}: the node type http.request is forbidden by the rules`)),
  },
]

const hostile: RuleViolation[] = [
  {
    workflowId: 'wf-hostile',
    name: '<img src=x onerror=alert(1)> \u202egpj\u200b</b> ' + 'very long name '.repeat(12),
    issues: [
      issue('/nodes/1/type', '<script>alert(2)</script> **bold** [link](https://evil.example) \u202eevil'),
      issue('/nodes/2/type', 'long message '.repeat(40)),
    ],
  },
]

const atTheLimit: RuleViolation[] = Array.from({ length: 200 }, (_, index) => ({
  workflowId: `wf-limit-${index + 1}`,
  name: `Imported workflow ${index + 1}`,
  issues: [issue('/nodes/1/type', 'node call: the node type http.request is forbidden by the rules')],
}))

export const violationFixtures = { one, several, manyIssues, atTheLimit, hostile }
