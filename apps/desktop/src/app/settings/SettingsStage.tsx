import { useState } from 'react'
import { createFakeClient } from '../../engine/fake-client'
import { createFakeHost, type FakeHostOptions, type FakeHostState } from '../../engine/fake-host'
import { fakeData } from '../../fixtures'
import { HostError, type HostApi } from '../../shared/host-api'
import { useEngineConnection, type ConnectFn } from '../connection'
import { withHostModels } from '../fake-world'
import { HostProvider } from '../host'
import { SettingsScreen } from './SettingsScreen'
import type { SettingsSectionId } from './types'
import { useSettings } from './useSettings'

export interface SettingsStageProps {
  init?: Partial<FakeHostState>
  options?: FakeHostOptions
  section?: SettingsSectionId
  failLoad?: boolean
}

function makeHost(props: SettingsStageProps): HostApi {
  const host = createFakeHost(props.init, props.options)
  if (props.failLoad !== true) return host
  return { ...host, settings: { ...host.settings, get: () => Promise.reject(new HostError('INTERNAL')) } }
}

function Inner({ host, section }: { host: HostApi; section: SettingsSectionId }) {
  const [connect] = useState<ConnectFn>(() => async () => withHostModels(createFakeClient(fakeData), host))
  const connection = useEngineConnection(host, { connect })
  const state = useSettings(host)
  const [current, setCurrent] = useState(section)
  return <SettingsScreen state={state} client={connection.client} connection={connection} section={current} onSectionChange={setCurrent} />
}

export function SettingsStage(props: SettingsStageProps) {
  const [host] = useState(() => makeHost(props))
  return (
    <div style={{ height: 640 }}>
      <HostProvider host={host}>
        <Inner host={host} section={props.section ?? 'folders'} />
      </HostProvider>
    </div>
  )
}
