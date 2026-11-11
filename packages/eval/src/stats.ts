export interface WilsonInterval {
  p: number
  lo: number
  hi: number
}

export function wilson(k: number, n: number, z = 1.96): WilsonInterval | null {
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 0 || k > n) throw new RangeError(`invalid proportion ${k}/${n}`)
  if (n === 0) return null
  const p = k / n
  const z2 = z * z
  const denominator = 1 + z2 / n
  const centre = (p + z2 / (2 * n)) / denominator
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator
  return { p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) }
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1))
    const held = result[index] as T
    result[index] = result[other] as T
    result[other] = held
  }
  return result
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null
  let total = 0
  for (const value of values) total += value
  return total / values.length
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const position = (Math.min(100, Math.max(0, p)) / 100) * (sorted.length - 1)
  const below = Math.floor(position)
  const above = Math.ceil(position)
  const low = sorted[below] as number
  const high = sorted[above] as number
  return low + (high - low) * (position - below)
}

export interface PairKey {
  group: string
  caseId: string
  rep: number
}

export interface BootstrapOptions {
  resamples?: number
  seed: number
}

export interface BootstrapDelta {
  delta: number | null
  lo: number | null
  hi: number | null
  groups: number
  pairs: number
  resamples: number
}

const DEFAULT_RESAMPLES = 10_000

function keyOf(row: PairKey): string {
  return JSON.stringify([row.group, row.caseId, row.rep])
}

function indexRows<R extends PairKey>(rows: readonly R[]): Map<string, R> {
  const index = new Map<string, R>()
  for (const row of rows) {
    const key = keyOf(row)
    if (index.has(key)) throw new Error(`duplicate row for ${key}`)
    index.set(key, row)
  }
  return index
}

function difference(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : b - a
}

// delta is metric(rowsB) - metric(rowsA), computed over rows paired by (group, caseId, rep)
export function clusterBootstrapDelta<R extends PairKey>(
  rowsA: readonly R[],
  rowsB: readonly R[],
  metric: (rows: readonly R[]) => number | null,
  options: BootstrapOptions,
): BootstrapDelta {
  const resamples = options.resamples ?? DEFAULT_RESAMPLES
  const indexA = indexRows(rowsA)
  const byGroup = new Map<string, { a: R[]; b: R[] }>()
  let pairs = 0
  for (const [key, rowB] of indexRows(rowsB)) {
    const rowA = indexA.get(key)
    if (rowA === undefined) continue
    const bucket = byGroup.get(rowB.group) ?? { a: [], b: [] }
    bucket.a.push(rowA)
    bucket.b.push(rowB)
    byGroup.set(rowB.group, bucket)
    pairs += 1
  }
  const clusters = [...byGroup.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([, bucket]) => bucket)
  if (clusters.length === 0) return { delta: null, lo: null, hi: null, groups: 0, pairs: 0, resamples: 0 }
  const delta = difference(metric(clusters.flatMap((cluster) => cluster.a)), metric(clusters.flatMap((cluster) => cluster.b)))
  const random = mulberry32(options.seed)
  const deltas: number[] = []
  for (let round = 0; round < resamples; round += 1) {
    const a: R[] = []
    const b: R[] = []
    for (let pick = 0; pick < clusters.length; pick += 1) {
      const cluster = clusters[Math.floor(random() * clusters.length)] as { a: R[]; b: R[] }
      a.push(...cluster.a)
      b.push(...cluster.b)
    }
    const value = difference(metric(a), metric(b))
    if (value !== null) deltas.push(value)
  }
  return { delta, lo: percentile(deltas, 2.5), hi: percentile(deltas, 97.5), groups: clusters.length, pairs, resamples: deltas.length }
}

export interface RatioRow {
  group: string
  num: number
  den: number
}

export interface BootstrapRatio {
  value: number | null
  lo: number | null
  hi: number | null
  groups: number
}

export function clusterBootstrapRatio(rows: readonly RatioRow[], options: BootstrapOptions): BootstrapRatio {
  const resamples = options.resamples ?? DEFAULT_RESAMPLES
  const byGroup = new Map<string, { num: number; den: number }>()
  for (const row of rows) {
    const cluster = byGroup.get(row.group) ?? { num: 0, den: 0 }
    cluster.num += row.num
    cluster.den += row.den
    byGroup.set(row.group, cluster)
  }
  const clusters = [...byGroup.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([, cluster]) => cluster)
  const totalDen = clusters.reduce((total, cluster) => total + cluster.den, 0)
  if (totalDen === 0) return { value: null, lo: null, hi: null, groups: clusters.length }
  const value = clusters.reduce((total, cluster) => total + cluster.num, 0) / totalDen
  const random = mulberry32(options.seed)
  const values: number[] = []
  for (let round = 0; round < resamples; round += 1) {
    let num = 0
    let den = 0
    for (let pick = 0; pick < clusters.length; pick += 1) {
      const cluster = clusters[Math.floor(random() * clusters.length)] as { num: number; den: number }
      num += cluster.num
      den += cluster.den
    }
    if (den > 0) values.push(num / den)
  }
  return { value, lo: percentile(values, 2.5), hi: percentile(values, 97.5), groups: clusters.length }
}
