import { stubDescriptor, type ProviderDescriptor } from '../descriptor'
import { GEMINI_MODELS } from './models'

export const geminiDescriptor: ProviderDescriptor = stubDescriptor({ id: 'gemini', label: 'Google Gemini', keyEnv: 'GEMINI_API_KEY', models: GEMINI_MODELS })
