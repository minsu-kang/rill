import type { Locale } from '../i18n'

const en = {
  'shell.title': 'Rill',
  'shell.engine': 'Engine',
  'shell.state.starting': 'Starting',
  'shell.state.running': 'Running',
  'shell.state.restarting': 'Restarting',
  'shell.state.stopped': 'Stopped',
  'shell.error.crashed': 'The engine stopped after repeated crashes.',
  'shell.error.start_timeout': 'The engine did not start in time.',
  'shell.error.no_keychain': 'There is no system keychain, so the engine was not started.',
  'shell.restarts': 'Restarts',
  'shell.ping': 'Ping',
  'shell.ping.pending': 'Waiting',
  'shell.ping.ok': '{ms} ms',
  'shell.ping.error': 'No answer',
  'shell.noHost': 'Run this page inside the Rill app.',
} as const

export type ShellMessageKey = keyof typeof en

const ko: Record<ShellMessageKey, string> = {
  'shell.title': 'Rill',
  'shell.engine': '엔진',
  'shell.state.starting': '시작하는 중',
  'shell.state.running': '실행 중',
  'shell.state.restarting': '다시 시작하는 중',
  'shell.state.stopped': '멈춤',
  'shell.error.crashed': '엔진이 반복해서 멈춰 중단되었습니다.',
  'shell.error.start_timeout': '엔진이 제때 시작하지 못했습니다.',
  'shell.error.no_keychain': '시스템 키체인이 없어 엔진을 시작하지 않았습니다.',
  'shell.restarts': '다시 시작 횟수',
  'shell.ping': '응답 시간',
  'shell.ping.pending': '기다리는 중',
  'shell.ping.ok': '{ms} ms',
  'shell.ping.error': '응답 없음',
  'shell.noHost': '앱 안에서 실행해 주세요. Rill 앱 안에서만 엔진에 연결됩니다.',
}

export const SHELL_MESSAGES: Record<Locale, Readonly<Record<ShellMessageKey, string>>> = { ko, en }

export function createShellTranslator(locale: Locale): (key: ShellMessageKey, vars?: Record<string, string | number>) => string {
  const dictionary = SHELL_MESSAGES[locale]
  return (key, vars) => {
    if (!Object.hasOwn(dictionary, key)) return key
    const template = dictionary[key]
    if (vars === undefined) return template
    return template.replace(/\{([a-zA-Z]+)\}/g, (whole, name: string) => (Object.hasOwn(vars, name) ? String(vars[name]) : whole))
  }
}
