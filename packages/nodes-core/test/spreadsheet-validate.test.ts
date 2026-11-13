import { isWarningIssue, type PlanIssue, type Workflow } from '@rill/dsl'
import { describe, expect, it } from 'vitest'
import { createCoreRegistry, validateWorkflow } from '../src/index'

type Node = Workflow['nodes'][number]

const registry = createCoreRegistry()
const SHEET = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms'

const n = (id: string, type: string, config: Record<string, unknown> = {}): Node => ({ id, type, config })
const chain = (...nodes: Node[]): Workflow => ({
  schemaVersion: 1,
  name: 'wf',
  nodes,
  edges: nodes.slice(1).map((node, i) => ({ from: nodes[i]!.id, to: node.id })),
})
const manual = n('t1', 'trigger.manual@1')
const google = (config: Record<string, unknown> = {}) => n('n1', 'google.sheets.append@1', { connection: 'g', spreadsheetId: SHEET, values: ['a', 1], ...config })
const excel = (config: Record<string, unknown> = {}) => n('n1', 'microsoft.excel.append@1', { connection: 'ms', filePath: 'Receipts/ledger.xlsx', table: 'Expenses', values: ['a', 1], ...config })
const errors = (workflow: Workflow, connections?: string[]): PlanIssue[] => validateWorkflow(workflow, { registry, ...(connections === undefined ? {} : { connections }) }).filter((issue) => !isWarningIssue(issue))
const brief = (issues: PlanIssue[]) => issues.map((issue) => `${issue.code} ${issue.pointer}`)

describe('validation of the spreadsheet nodes', () => {
  it('accepts both nodes with literal values and with configured connections', () => {
    expect(errors(chain(manual, google()), ['g'])).toEqual([])
    expect(errors(chain(manual, excel()), ['ms'])).toEqual([])
  })

  it('reports a connection that is not configured', () => {
    expect(brief(errors(chain(manual, google()), ['other']))).toEqual(['unknown_connection /nodes/1/config/connection'])
    expect(brief(errors(chain(manual, excel()), [])).join()).toContain('unknown_connection /nodes/1/config/connection')
  })

  it('reports a spreadsheet id, a range, a file path or a table that breaks the grammar', () => {
    expect(errors(chain(manual, google({ spreadsheetId: 'short' }))).map((issue) => issue.pointer)).toContain('/nodes/1/config/spreadsheetId')
    expect(errors(chain(manual, google({ range: 'a/b' }))).map((issue) => issue.pointer)).toEqual(['/nodes/1/config/range'])
    expect(errors(chain(manual, excel({ filePath: '../x.xlsx' }))).map((issue) => issue.pointer)).toEqual(['/nodes/1/config/filePath'])
    expect(errors(chain(manual, excel({ filePath: 'x.csv' }))).map((issue) => issue.pointer)).toEqual(['/nodes/1/config/filePath'])
    expect(errors(chain(manual, excel({ table: '..' }))).map((issue) => issue.pointer)).toEqual(['/nodes/1/config/table'])
  })

  it('lets a reference stand in for the spreadsheet id, the file path and a cell', () => {
    const pick = n('p1', 'transform@1', { values: { id: 'x' } })
    const workflow = chain(manual, pick, n('n1', 'google.sheets.append@1', { connection: 'g', spreadsheetId: '{{p1.output.id}}', values: ['{{p1.output.id}}', 'a'] }))
    expect(errors(workflow, ['g']).filter((issue) => issue.pointer.includes('spreadsheetId') || issue.pointer.includes('values'))).toEqual([])
    const workflowExcel = chain(manual, pick, n('n1', 'microsoft.excel.append@1', { connection: 'ms', filePath: 'Receipts/{{p1.output.id}}.xlsx', table: '{{p1.output.id}}', values: ['a'] }))
    expect(errors(workflowExcel, ['ms']).filter((issue) => issue.pointer.includes('filePath') || issue.pointer.includes('table'))).toEqual([])
  })

  it('offers the output fields of the nodes to later references', () => {
    const workflow = chain(manual, google(), n('n2', 'transform@1', { values: { range: '{{n1.output.updatedRange}}' } }))
    expect(errors(workflow, ['g'])).toEqual([])
    const missing = chain(manual, excel(), n('n2', 'transform@1', { values: { range: '{{n1.output.updatedRange}}' } }))
    expect(brief(errors(missing, ['ms']))).toContain('unknown_output_field /nodes/2/config/values/range')
  })
})
