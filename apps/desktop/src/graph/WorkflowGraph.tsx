import '@xyflow/react/dist/style.css'
import type { Workflow, WorkflowNode } from '@rill/dsl'
import type { NodeInfo } from '@rill/protocol'
import {
  BaseEdge,
  Controls,
  getSmoothStepPath,
  Handle,
  Position,
  ReactFlow,
  type AriaLabelConfig,
  type Edge,
  type EdgeProps,
  type EdgeTypes,
  type Node,
  type NodeChange,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react'
import { useCallback, useId, useMemo, useState } from 'react'
import { useT, type Translate } from '../i18n'
import { displayState, type NodeRunState, type NodeStatus, type RunStates } from '../model/status'
import { truncate } from '../model/text'
import { layoutWorkflow } from './layout'
import { CARD_SIZE, NodeCard } from './NodeCard'
import styles from './WorkflowGraph.module.css'

export interface WorkflowGraphProps {
  workflow: Workflow
  catalog: readonly NodeInfo[]
  states: RunStates
  selectedNodeId?: string
  onSelect?(nodeId: string | undefined): void
}

interface StepData extends Record<string, unknown> {
  node: WorkflowNode
  info: NodeInfo | undefined
  state: NodeRunState | undefined
}

interface LinkData extends Record<string, unknown> {
  when: string | undefined
  flowing: boolean
  skipped: boolean
}

type StepNode = Node<StepData, 'step'>
type LinkEdge = Edge<LinkData, 'link'>
type Size = { width: number; height: number }

const MAX_LABEL = 24
const FLOWING: ReadonlySet<NodeStatus> = new Set(['running', 'succeeded', 'failed', 'abandoned', 'continued'])

function FlowNode({ data, selected }: NodeProps<StepNode>) {
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} className={styles.handle} aria-hidden="true" />
      <NodeCard node={data.node} info={data.info} state={data.state} selected={selected} />
      <Handle type="source" position={Position.Right} isConnectable={false} className={styles.handle} aria-hidden="true" />
    </>
  )
}

function FlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, data }: EdgeProps<LinkEdge>) {
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 12 })
  const when = data?.when
  return (
    <BaseEdge
      id={id}
      path={path}
      markerEnd={markerEnd}
      style={style}
      label={when === undefined ? undefined : truncate(when, MAX_LABEL)}
      labelX={labelX}
      labelY={labelY}
      labelShowBg
      labelBgPadding={[6, 3]}
      labelBgBorderRadius={4}
    />
  )
}

const nodeTypes: NodeTypes = { step: FlowNode }
const edgeTypes: EdgeTypes = { link: FlowEdge }

function ariaLabels(t: Translate): Partial<AriaLabelConfig> {
  return {
    'node.a11yDescription.default': t('graph.nodeHint'),
    'node.a11yDescription.keyboardDisabled': t('graph.nodeHint'),
    'node.a11yDescription.ariaLiveMessage': () => '',
    'edge.a11yDescription.default': t('graph.edgeHint'),
    'controls.ariaLabel': t('graph.controls'),
    'controls.zoomIn.ariaLabel': t('graph.zoomIn'),
    'controls.zoomOut.ariaLabel': t('graph.zoomOut'),
    'controls.fitView.ariaLabel': t('graph.fitView'),
    'handle.ariaLabel': t('graph.handle'),
  }
}

function structureKey(workflow: Workflow): string {
  return `${workflow.nodes.map((item) => item.id).join('|')}#${workflow.edges.map((link) => `${link.from}>${link.to}`).join('|')}`
}

export function WorkflowGraph(props: WorkflowGraphProps) {
  const t = useT()
  if (props.workflow.nodes.length === 0) {
    return (
      <div className={styles.empty} role="region" aria-label={t('graph.label')}>
        {t('graph.empty')}
      </div>
    )
  }
  return <GraphCanvas key={structureKey(props.workflow)} {...props} />
}

function GraphCanvas({ workflow, catalog, states, selectedNodeId, onSelect }: WorkflowGraphProps) {
  const t = useT()
  const markerId = `arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const [measured, setMeasured] = useState<ReadonlyMap<string, Size>>(() => new Map())

  const layout = useMemo(() => layoutWorkflow(workflow, CARD_SIZE), [workflow])
  const infoByType = useMemo(() => new Map(catalog.map((info) => [info.type, info])), [catalog])
  const labels = useMemo(() => ariaLabels(t), [t])

  const nodes = useMemo(() => {
    const hasRun = Object.keys(states).length > 0
    const places = new Map(layout.nodes.map((place) => [place.id, place]))
    const seen = new Set<string>()
    const result: StepNode[] = []
    for (const item of workflow.nodes) {
      const place = places.get(item.id)
      if (place === undefined || seen.has(item.id)) continue
      seen.add(item.id)
      const state = displayState(item, states, hasRun)
      const info = infoByType.get(item.type)
      result.push({
        id: item.id,
        type: 'step',
        position: { x: place.x, y: place.y },
        data: { node: item, info, state },
        selected: item.id === selectedNodeId,
        draggable: false,
        connectable: false,
        deletable: false,
        initialWidth: CARD_SIZE.width,
        initialHeight: CARD_SIZE.height,
        measured: measured.get(item.id),
        ariaLabel: t('graph.nodeLabel', { title: truncate(info?.title ?? item.type, 40), id: truncate(item.id, 32), status: t(`status.${state?.status ?? 'idle'}`) }),
      })
    }
    return result
  }, [workflow, layout, infoByType, states, selectedNodeId, measured, t])

  const edges = useMemo(() => {
    const known = new Map(nodes.map((item) => [item.id, item.data.state]))
    const result: LinkEdge[] = []
    workflow.edges.forEach((link, index) => {
      if (!known.has(link.from) || !known.has(link.to)) return
      const target = known.get(link.to)
      const flowing = target !== undefined && FLOWING.has(target.status)
      const skipped = target?.status === 'skipped'
      result.push({
        id: `edge-${index}`,
        type: 'link',
        source: link.from,
        target: link.to,
        selectable: false,
        focusable: false,
        deletable: false,
        reconnectable: false,
        markerEnd: `url(#${markerId}-${flowing ? 'active' : 'idle'})`,
        style: {
          stroke: flowing ? 'var(--edge-active)' : 'var(--edge-default)',
          strokeWidth: flowing ? 2 : 1.5,
          strokeDasharray: skipped ? '4 4' : undefined,
        },
        data: { when: link.when, flowing, skipped },
      })
    })
    return result
  }, [workflow, nodes, markerId])

  const onNodesChange = useCallback(
    (changes: NodeChange<StepNode>[]) => {
      let picked: string | undefined
      let cleared = false
      for (const change of changes) {
        if (change.type === 'dimensions' && change.dimensions !== undefined) {
          const { id, dimensions } = change
          setMeasured((previous) => {
            const current = previous.get(id)
            if (current?.width === dimensions.width && current.height === dimensions.height) return previous
            return new Map(previous).set(id, { width: dimensions.width, height: dimensions.height })
          })
        } else if (change.type === 'select') {
          if (change.selected) picked = change.id
          else if (change.id === selectedNodeId) cleared = true
        }
      }
      if (onSelect === undefined) return
      if (picked !== undefined) onSelect(picked)
      else if (cleared) onSelect(undefined)
    },
    [onSelect, selectedNodeId],
  )

  const onPaneClick = useCallback(() => onSelect?.(undefined), [onSelect])

  return (
    <div className={styles.root} role="region" aria-label={t('graph.label')}>
      <svg className={styles.defs} aria-hidden="true" focusable="false">
        <defs>
          {(['idle', 'active'] as const).map((kind) => (
            <marker key={kind} id={`${markerId}-${kind}`} markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto" markerUnits="userSpaceOnUse">
              <path d="M0 0.5L8.5 4.5L0 8.5z" style={{ fill: kind === 'active' ? 'var(--edge-active)' : 'var(--edge-default)' }} />
            </marker>
          ))}
        </defs>
      </svg>
      <ReactFlow<StepNode, LinkEdge>
        className={styles.flow}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onPaneClick={onPaneClick}
        ariaLabelConfig={labels}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable
        edgesFocusable={false}
        elementsSelectable
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        zoomOnDoubleClick={false}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
        minZoom={0.2}
        maxZoom={1.5}
      >
        <Controls showInteractive={false} position="bottom-left" />
      </ReactFlow>
    </div>
  )
}
