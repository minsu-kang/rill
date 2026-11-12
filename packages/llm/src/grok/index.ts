import { stubDescriptor, type ProviderDescriptor } from '../descriptor'
import { GROK_MODELS } from './models'

export const grokDescriptor: ProviderDescriptor = stubDescriptor({ id: 'grok', label: 'xAI Grok', keyEnv: 'XAI_API_KEY', models: GROK_MODELS })
