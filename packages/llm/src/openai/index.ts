import { stubDescriptor, type ProviderDescriptor } from '../descriptor'
import { OPENAI_MODELS } from './models'

export const openaiDescriptor: ProviderDescriptor = stubDescriptor({ id: 'openai', label: 'OpenAI', keyEnv: 'OPENAI_API_KEY', models: OPENAI_MODELS })
