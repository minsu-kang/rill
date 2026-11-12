import { useMemo, useState, type ReactNode } from 'react'
import { useT } from '../i18n'
import { SafeText, VisibleText } from '../ui/SafeText'
import { summarize, TEMPLATE_REF, type JsonNode } from './json-model'
import styles from './JsonView.module.css'

export interface JsonViewProps {
  value: unknown
  maxDepth?: number
  maxItems?: number
  maxString?: number
  maxRows?: number
}

const DEFAULTS = { maxDepth: 4, maxItems: 50, maxString: 500, maxRows: 300 }

export function JsonView({ value, maxDepth = DEFAULTS.maxDepth, maxItems = DEFAULTS.maxItems, maxString = DEFAULTS.maxString, maxRows = DEFAULTS.maxRows }: JsonViewProps) {
  const tree = useMemo(() => summarize(value, { maxDepth, maxItems, maxString, maxRows }), [value, maxDepth, maxItems, maxString, maxRows])
  return (
    <div className={styles.root}>
      <NodeView node={tree} />
    </div>
  )
}

export function CappedText({ text, maxString = DEFAULTS.maxString }: { text: string; maxString?: number }) {
  const node = useMemo(() => summarize(text, { ...DEFAULTS, maxString }), [text, maxString])
  return (
    <div className={styles.root}>
      <NodeView node={node} plain />
    </div>
  )
}

function NodeView({ node, plain = false }: { node: JsonNode; plain?: boolean }) {
  switch (node.kind) {
    case 'scalar':
      return <span className={styles[node.tone]}>{node.text}</span>
    case 'string':
      return <StringView full={node.full} shown={node.shown} hidden={node.hidden} plain={plain} />
    case 'container':
      return <ContainerView node={node} />
  }
}

function pieces(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  for (const match of text.matchAll(TEMPLATE_REF)) {
    const at = match.index
    if (at > last) out.push(<VisibleText key={`t${last}`} text={text.slice(last, at)} />)
    out.push(
      <span key={`r${at}`} className={styles.ref} data-template-ref="">
        {match[0]}
      </span>,
    )
    last = at + match[0].length
  }
  if (last < text.length) out.push(<VisibleText key={`t${last}`} text={text.slice(last)} />)
  return out
}

function StringView({ full, shown, hidden, plain }: { full: string; shown: string; hidden: number; plain: boolean }) {
  const t = useT()
  const [expanded, setExpanded] = useState(false)
  const open = expanded && hidden > 0
  const text = open ? full : shown
  return (
    <span className={plain ? styles.plainText : styles.string}>
      <span className={plain ? undefined : styles.quoted}>
        <bdi>{plain ? <VisibleText text={text} /> : pieces(text)}</bdi>
      </span>
      {hidden > 0 && !open && <span className={styles.more}> {t('json.moreCharacters', { count: hidden })}</span>}
      {hidden > 0 && (
        <button type="button" className={styles.toggle} onClick={() => setExpanded(!open)}>
          {open ? t('json.showLess') : t('json.showMore')}
        </button>
      )}
    </span>
  )
}

function ContainerView({ node }: { node: Extract<JsonNode, { kind: 'container' }> }) {
  const t = useT()
  const [open, close] = node.array ? ['[', ']'] : ['{', '}']
  if (node.collapsed) {
    return (
      <span>
        <span className={styles.punct}>{`${open}…${close}`}</span>
        {node.size > 0 && <span className={styles.more}> {t('json.more', { count: node.size })}</span>}
      </span>
    )
  }
  if (node.size === 0) return <span className={styles.punct}>{`${open}${close}`}</span>
  return (
    <span>
      <span className={styles.punct}>{open}</span>
      <span className={styles.children}>
        {node.entries.map((entry) => (
          <span key={entry.key} className={styles.entry} data-entry="">
            <span className={styles.key}>
              <SafeText text={entry.key} />
            </span>
            <span className={styles.punct}>: </span>
            <NodeView node={entry.value} />
          </span>
        ))}
        {node.hidden > 0 && <span className={styles.hiddenCount}>{t('json.more', { count: node.hidden })}</span>}
      </span>
      <span className={styles.punct}>{close}</span>
    </span>
  )
}
