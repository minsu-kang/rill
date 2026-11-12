import { ANTHROPIC_MODELS } from './anthropic-descriptor'
import type { ModelInfo } from './capabilities'
import { GEMINI_MODELS } from './gemini/models'
import { GROK_MODELS } from './grok/models'
import { META_MODELS } from './meta/models'
import { OPENAI_MODELS } from './openai/models'

export const MODEL_TABLE: readonly ModelInfo[] = [...ANTHROPIC_MODELS, ...OPENAI_MODELS, ...GEMINI_MODELS, ...GROK_MODELS, ...META_MODELS]
