import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const fixture = join(root, 'packages/nodes-core/test/fixtures/cron-dst.ts')

function runLocal(timeZone: string, expression: string, after: string, count: number): string[] {
  const output = execFileSync(process.execPath, ['--import', 'tsx', fixture, expression, after, String(count)], {
    cwd: root,
    env: { ...process.env, TZ: timeZone },
    encoding: 'utf8',
  })
  return JSON.parse(output) as string[]
}

describe('nextCronTime in a zone with daylight saving time', () => {
  it('does not skip real hours when the clocks fall back', () => {
    expect(runLocal('America/New_York', '0 * * * *', '2026-11-01T04:30:00Z', 4)).toEqual([
      '2026-11-01T05:00:00.000Z',
      '2026-11-01T06:00:00.000Z',
      '2026-11-01T07:00:00.000Z',
      '2026-11-01T08:00:00.000Z',
    ])
    expect(runLocal('America/New_York', '*/15 * * * *', '2026-11-01T05:30:00Z', 4)).toEqual([
      '2026-11-01T05:45:00.000Z',
      '2026-11-01T06:00:00.000Z',
      '2026-11-01T06:15:00.000Z',
      '2026-11-01T06:30:00.000Z',
    ])
  })

  it('skips a local time that does not exist on the spring-forward day and resumes the next day', () => {
    expect(runLocal('America/New_York', '30 2 * * *', '2026-03-08T05:00:00Z', 2)).toEqual([
      '2026-03-09T06:30:00.000Z',
      '2026-03-10T06:30:00.000Z',
    ])
    expect(runLocal('America/New_York', '0 * * * *', '2026-03-08T06:30:00Z', 2)).toEqual([
      '2026-03-08T07:00:00.000Z',
      '2026-03-08T08:00:00.000Z',
    ])
  })

  it('runs a fixed local time once on the day the clocks fall back', () => {
    expect(runLocal('America/New_York', '30 1 * * *', '2026-11-01T04:00:00Z', 2)).toEqual([
      '2026-11-01T05:30:00.000Z',
      '2026-11-02T06:30:00.000Z',
    ])
  })

  it('keeps a daily local time across the change', () => {
    expect(runLocal('America/New_York', '0 9 * * *', '2026-11-01T00:00:00Z', 3)).toEqual([
      '2026-11-01T14:00:00.000Z',
      '2026-11-02T14:00:00.000Z',
      '2026-11-03T14:00:00.000Z',
    ])
  })
})
