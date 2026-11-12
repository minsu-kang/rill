import { useState } from 'react'
import type { FakeWorldOptions } from './fake-world'
import { createFakeWorld } from './fake-world'
import { App, type AppProps } from './App'
import { HostProvider } from './host'

export interface AppStageProps {
  world?: FakeWorldOptions
  initial?: AppProps['initial']
  width?: number
}

export function AppStage({ world: worldOptions, initial, width }: AppStageProps) {
  const [world] = useState(() => createFakeWorld({ hostOptions: { restartDelayMs: 150 }, ...worldOptions }))
  return (
    <div style={width === undefined ? undefined : { width, margin: '0 auto', outline: '1px dashed var(--border-strong)' }}>
      <HostProvider host={world.host} connect={world.connect}>
        <App initial={initial} />
      </HostProvider>
    </div>
  )
}
