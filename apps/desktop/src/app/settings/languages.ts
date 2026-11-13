import type { Language } from '../../shared/host-api'

export const LANGUAGE_OPTIONS: ReadonlyArray<{ value: Language; label: string }> = [
  { value: 'system', label: 'System default / 시스템 기본값' },
  { value: 'en', label: 'English' },
  { value: 'ko', label: '한국어' },
]
