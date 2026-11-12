import type { Meta, StoryObj } from '@storybook/react-vite'
import type { EngineInfo, EngineStatus, HostApi } from '../shared/host-api'
import { StatusPage, type PingClient } from './StatusPage'

const INFO: EngineInfo = { url: 'ws://127.0.0.1:43000/', token: 'story-token-not-a-secret', protocol: 1 }

function host(options: { status?: EngineStatus; info?: 'ready' | 'never' }): Pick<HostApi, 'engine'> {
  return {
    engine: {
      info: () => (options.info === 'never' ? new Promise<EngineInfo>(() => undefined) : Promise.resolve(INFO)),
      restart: () => Promise.resolve(),
      status: () => Promise.resolve(options.status ?? { state: 'running', restarts: 0 }),
      onStatus: (listener) => {
        if (options.status !== undefined) {
          const status = options.status
          queueMicrotask(() => listener(status))
        }
        return () => undefined
      },
    },
  }
}

const answers = async (): Promise<PingClient> => ({ request: async () => ({ time: 1 }), close: () => undefined })
const silent = async (): Promise<PingClient> => ({ request: () => Promise.reject(new Error('no answer')), close: () => undefined })

const meta = { title: 'Shell/StatusPage', component: StatusPage, args: { host: undefined, connect: answers } } satisfies Meta<typeof StatusPage>

export default meta

type Story = StoryObj<typeof meta>

export const OutsideTheApp: Story = {}

export const Running: Story = { args: { host: host({ status: { state: 'running', restarts: 0 } }) } }

export const Starting: Story = { args: { host: host({ status: { state: 'starting', restarts: 0 }, info: 'never' }) } }

export const Restarting: Story = { args: { host: host({ status: { state: 'restarting', restarts: 2 } }) } }

export const StoppedAfterCrashes: Story = { args: { host: host({ status: { state: 'stopped', error: 'crashed', restarts: 5 } }) } }

export const StoppedWithoutKeychain: Story = { args: { host: host({ status: { state: 'stopped', error: 'no_keychain', restarts: 0 } }) } }

export const EngineDoesNotAnswer: Story = { args: { host: host({ status: { state: 'running', restarts: 0 } }), connect: silent } }
