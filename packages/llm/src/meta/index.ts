import { stubDescriptor, type ProviderDescriptor } from '../descriptor'
import { META_MODELS } from './models'

export const metaDescriptor: ProviderDescriptor = stubDescriptor({ id: 'meta', label: 'Meta (Muse)', keyEnv: 'META_API_KEY', models: META_MODELS })
