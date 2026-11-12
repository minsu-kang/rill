import type { RillClient } from '@rill/protocol'

export type EngineClient = Pick<RillClient, 'request' | 'onEvent'>
