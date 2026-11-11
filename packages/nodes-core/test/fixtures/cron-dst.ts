import { nextCronTime, parseCron } from '../../src/cron'

const [expression, afterIso, count] = process.argv.slice(2)
const spec = parseCron(expression!)
let cursor = new Date(afterIso!).getTime()
const times: string[] = []
for (let i = 0; i < Number(count); i += 1) {
  const next = nextCronTime(spec, cursor, 'local')
  if (next === null) break
  times.push(new Date(next).toISOString())
  cursor = next
}
console.log(JSON.stringify(times))
