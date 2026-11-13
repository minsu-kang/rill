import type { NodeInfo } from '@rill/protocol'
import type { ReactNode } from 'react'
import type { EngineClient } from '../../engine/client'
import type { MessageKey } from '../../i18n'
import type { CatalogStatus } from '../glue/useEngineData'
import type { HostApi } from '../../shared/host-api'
import { AgentsScreen } from './AgentsScreen'
import styles from './AgentsTab.module.css'
import { RulesScreen } from './RulesScreen'
import { SubNav } from './SubNav'

export interface AgentsSectionContext {
  client: EngineClient
  catalog: readonly NodeInfo[]
  catalogStatus?: CatalogStatus
  onRetryCatalog?(): void
  files?: Pick<HostApi['dialogs'], 'openText' | 'saveText'>
}

export interface AgentsSection {
  id: string
  label: MessageKey
  render(context: AgentsSectionContext): ReactNode
}

export const AGENTS_SECTIONS = [
  {
    id: 'agents',
    label: 'agents.nav.agents',
    render: ({ client, files }) => <AgentsScreen client={client} {...(files === undefined ? {} : { files })} />,
  },
  {
    id: 'rules',
    label: 'agents.nav.rules',
    render: ({ client, catalog, catalogStatus, onRetryCatalog }) => (
      <RulesScreen client={client} catalog={catalog} {...(catalogStatus === undefined ? {} : { catalogStatus })} {...(onRetryCatalog === undefined ? {} : { onRetryCatalog })} />
    ),
  },
] as const satisfies readonly AgentsSection[]

export type AgentsSectionId = (typeof AGENTS_SECTIONS)[number]['id']

export interface AgentsTabProps extends AgentsSectionContext {
  section: AgentsSectionId
  onSectionChange(section: AgentsSectionId): void
}

export function AgentsTab({ section, onSectionChange, ...context }: AgentsTabProps) {
  const current = AGENTS_SECTIONS.find((entry) => entry.id === section) ?? AGENTS_SECTIONS[0]
  return (
    <div className={styles.root}>
      <SubNav label="agents.nav.label" items={AGENTS_SECTIONS} current={current.id} onChange={(id) => onSectionChange(id as AgentsSectionId)} />
      {current.render(context)}
    </div>
  )
}
