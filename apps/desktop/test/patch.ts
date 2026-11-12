import type { Workflow } from '@rill/dsl'
import type { PatchOp } from '@rill/protocol'

export function applyPatch(workflow: Workflow, ops: readonly PatchOp[]): Workflow {
  let nodes = workflow.nodes.map((node) => structuredClone(node))
  let edges = workflow.edges.map((edge) => ({ ...edge }))
  for (const op of ops) {
    switch (op.op) {
      case 'add_node':
        nodes = [...nodes, structuredClone(op.node)]
        break
      case 'set_config':
        nodes = nodes.map((node) =>
          node.id === op.nodeId
            ? { ...node, config: structuredClone(op.config), ...(op.retry === undefined ? {} : { retry: op.retry }), ...(op.onError === undefined ? {} : { onError: op.onError }) }
            : node,
        )
        break
      case 'remove_node':
        nodes = nodes.filter((node) => node.id !== op.nodeId)
        edges = edges.filter((edge) => edge.from !== op.nodeId && edge.to !== op.nodeId)
        break
      case 'connect':
        edges = [...edges, { ...op.edge }]
        break
      case 'disconnect':
        edges = edges.filter((edge) => !(edge.from === op.from && edge.to === op.to))
        break
    }
  }
  return { ...workflow, nodes, edges }
}
