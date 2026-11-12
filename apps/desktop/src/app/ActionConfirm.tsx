import type { NodeInfo } from '@rill/protocol'
import type { EngineClient } from '../engine/client'
import { useT, type MessageKey } from '../i18n'
import { ConfirmDialog } from './workflows/ConfirmDialog'
import { SideEffects, useSideEffects } from './workflows/SideEffects'

export interface ActionConfirmProps {
  client: EngineClient
  catalog: readonly NodeInfo[]
  title: MessageKey
  message: MessageKey
  confirmLabel: MessageKey
  effectsOf?: string
  onAnswer(ok: boolean): void
}

export function ActionConfirm({ effectsOf, ...rest }: ActionConfirmProps) {
  return effectsOf === undefined ? <Plain {...rest} /> : <WithEffects {...rest} workflowId={effectsOf} />
}

type Shared = Omit<ActionConfirmProps, 'effectsOf'>

function Plain({ title, message, confirmLabel, onAnswer }: Shared) {
  const t = useT()
  return <ConfirmDialog title={t(title)} message={t(message)} confirmLabel={t(confirmLabel)} cancelLabel={t('app.common.cancel')} onCancel={() => onAnswer(false)} onConfirm={() => onAnswer(true)} />
}

function WithEffects({ client, catalog, title, message, confirmLabel, workflowId, onAnswer }: Shared & { workflowId: string }) {
  const t = useT()
  const state = useSideEffects(client, workflowId, catalog)
  return (
    <ConfirmDialog
      title={t(title)}
      message={t(message)}
      details={<SideEffects state={state} />}
      confirmLabel={t(confirmLabel)}
      cancelLabel={t('app.common.cancel')}
      confirmDisabled={state.status !== 'ready'}
      onCancel={() => onAnswer(false)}
      onConfirm={() => onAnswer(true)}
    />
  )
}
