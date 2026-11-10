import { createCoreRegistry, defineAction } from '@rill/nodes-core'
import Type from 'typebox'
import { Db } from '../../src/db'
import { Engine } from '../../src/engine'

const [mode, dbPath, csvPath] = process.argv.slice(2)
const hang = process.env.RILL_HANG === '1'

const registry = createCoreRegistry().register(
  defineAction({
    type: 'test.gate@1',
    title: 'Gate',
    description: 'Blocks forever when RILL_HANG=1, otherwise passes.',
    sideEffect: 'none',
    configSchema: Type.Object({}, { additionalProperties: false }),
    outputSchema: Type.Object({ passed: Type.Boolean() }),
    execute: async () => {
      if (!hang) return { passed: true }
      console.log('READY')
      setInterval(() => {}, 1000)
      return new Promise<never>(() => {})
    },
  }),
)

const db = Db.open(dbPath!)
const engine = new Engine({ db, registry })

if (mode === 'start') {
  const id = engine.deploy({
    schemaVersion: 1,
    name: 'kill-test',
    nodes: [
      { id: 't1', type: 'trigger.manual@1', config: {} },
      { id: 'n1', type: 'csv.append@1', config: { file: csvPath, row: ['receipt', 12.5] } },
      { id: 'n2', type: 'test.gate@1', config: {} },
    ],
    edges: [
      { from: 't1', to: 'n1' },
      { from: 'n1', to: 'n2' },
    ],
  })
  console.log(JSON.stringify(await engine.startRun(id, {})))
} else {
  console.log(JSON.stringify(await engine.recover()))
}
db.close()
