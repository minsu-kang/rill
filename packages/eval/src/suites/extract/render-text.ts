import type { LineItem, Seed } from './seed'

export const TEMPLATES = ['thermal', 'kr-pos', 'card-slip', 'invoice-table', 'email-order', 'plain-doc'] as const
export type Template = (typeof TEMPLATES)[number]

export const LANGUAGES = ['ko', 'en', 'mixed'] as const
export type Language = (typeof LANGUAGES)[number]

export const DATE_FORMATS = [
  'YYYY-MM-DD',
  'YYYY.MM.DD',
  'YYYY/MM/DD',
  'YY/MM/DD',
  'YY.MM.DD',
  'DD/MM/YYYY',
  'DD/MM/YY',
  'MM/DD/YYYY',
  'MM/DD/YY',
  'DD.MM.YYYY',
  'D MMM YYYY',
  'MMM D, YYYY',
  'MMMM D, YYYY',
  'YYYY년 M월 D일',
] as const
export type DateFormat = (typeof DATE_FORMATS)[number]

export const NUMBER_FORMAT_NAMES = ['1,234.50', '1.234,50', '1 234,50', "1'234.50", '1234.50', '12,500', '12500'] as const
export type NumberFormat = (typeof NUMBER_FORMAT_NAMES)[number]

export interface NumberFormatSpec {
  group: string
  decimal: string
  decimals: number
}

export const NUMBER_FORMATS = {
  '1,234.50': { group: ',', decimal: '.', decimals: 2 },
  '1.234,50': { group: '.', decimal: ',', decimals: 2 },
  '1 234,50': { group: ' ', decimal: ',', decimals: 2 },
  "1'234.50": { group: "'", decimal: '.', decimals: 2 },
  '1234.50': { group: '', decimal: '.', decimals: 2 },
  '12,500': { group: ',', decimal: '', decimals: 0 },
  '12500': { group: '', decimal: '', decimals: 0 },
} as const satisfies Record<NumberFormat, NumberFormatSpec>

export const SYMBOL_POSITIONS = ['prefix', 'suffix', 'none'] as const
export type SymbolPosition = (typeof SYMBOL_POSITIONS)[number]

export const SLOTS = ['header', 'meta', 'beforeTotals', 'afterTotals', 'footer'] as const
export type Slot = (typeof SLOTS)[number]

export const INJECTION_POSITIONS = [...SLOTS, 'items'] as const
export type InjectionPosition = (typeof INJECTION_POSITIONS)[number]

export const OMITTABLE = [
  'vendor',
  'date',
  'time',
  'payment',
  'subtotal',
  'discount',
  'tax',
  'tip',
  'total',
  'change',
  'prices',
] as const
export type Omittable = (typeof OMITTABLE)[number]

export const CURRENCY_CODES = ['USD', 'EUR', 'GBP', 'KRW', 'JPY', 'CHF'] as const
export type Currency = (typeof CURRENCY_CODES)[number]

export const CURRENCY_DECIMALS = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  KRW: 0,
  JPY: 0,
  CHF: 2,
} as const satisfies Record<Currency, number>

export const LABEL_KEYS = [
  'receipt',
  'vendor',
  'date',
  'time',
  'item',
  'qty',
  'price',
  'amount',
  'subtotal',
  'discount',
  'tax',
  'taxIncl',
  'net',
  'tip',
  'total',
  'change',
  'cashIn',
  'payment',
  'paidBy',
  'thanks',
  'receiptNo',
  'approval',
  'approved',
  'copy',
  'orderNo',
  'orderDate',
  'summary',
  'title',
  'pageFooter',
] as const
export type LabelKey = (typeof LABEL_KEYS)[number]
export type Labels = Record<LabelKey, string>

const MONTH_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const

interface CurrencySymbols {
  pre: string
  preSp: string
  suf: string
  sufSp: string
}

const CURRENCIES: Record<Currency, CurrencySymbols> = {
  USD: { pre: '$', preSp: '', suf: '$', sufSp: ' ' },
  EUR: { pre: '€', preSp: '', suf: '€', sufSp: ' ' },
  GBP: { pre: '£', preSp: '', suf: '£', sufSp: ' ' },
  KRW: { pre: '₩', preSp: '', suf: '원', sufSp: '' },
  JPY: { pre: '¥', preSp: '', suf: '円', sufSp: '' },
  CHF: { pre: 'CHF', preSp: ' ', suf: 'CHF', sufSp: ' ' },
}

const LABELS: Record<Language, Labels> = {
  en: {
    receipt: 'RECEIPT',
    vendor: 'Store',
    date: 'Date',
    time: 'Time',
    item: 'Item',
    qty: 'Qty',
    price: 'Unit price',
    amount: 'Amount',
    subtotal: 'Subtotal',
    discount: 'Discount',
    tax: 'Tax',
    taxIncl: 'Tax (incl.)',
    net: 'Net amount',
    tip: 'Tip',
    total: 'TOTAL',
    change: 'Change',
    cashIn: 'Cash tendered',
    payment: 'Payment',
    paidBy: 'Paid by',
    thanks: 'Thank you!',
    receiptNo: 'Receipt No.',
    approval: 'Auth code',
    approved: 'APPROVED',
    copy: 'Customer copy',
    orderNo: 'Order number',
    orderDate: 'Order date',
    summary: 'Order summary',
    title: 'INVOICE',
    pageFooter: '- 2 -',
  },
  ko: {
    receipt: '영수증',
    vendor: '상호',
    date: '일시',
    time: '시각',
    item: '상품명',
    qty: '수량',
    price: '단가',
    amount: '금액',
    subtotal: '주문금액',
    discount: '할인',
    tax: '부가세',
    taxIncl: '부가세(포함)',
    net: '공급가액',
    tip: '봉사료',
    total: '합계',
    change: '거스름돈',
    cashIn: '받은금액',
    payment: '결제수단',
    paidBy: '결제수단',
    thanks: '이용해 주셔서 감사합니다.',
    receiptNo: '거래번호',
    approval: '승인번호',
    approved: '승인완료',
    copy: '고객용',
    orderNo: '주문번호',
    orderDate: '주문일',
    summary: '주문 내역',
    title: '거래명세서',
    pageFooter: '- 2 -',
  },
  mixed: {
    receipt: '영수증 RECEIPT',
    vendor: '상호 Store',
    date: '일시 Date',
    time: '시각 Time',
    item: '상품명 Item',
    qty: '수량 Qty',
    price: '단가 Price',
    amount: '금액 Amount',
    subtotal: '소계 Subtotal',
    discount: '할인 Discount',
    tax: '부가세 VAT',
    taxIncl: '부가세 VAT (incl.)',
    net: '공급가액 Net',
    tip: '봉사료 Tip',
    total: '합계 Total',
    change: '거스름돈 Change',
    cashIn: '받은금액 Cash',
    payment: '결제 Payment',
    paidBy: '결제 Paid by',
    thanks: '감사합니다 Thank you!',
    receiptNo: 'No.',
    approval: '승인번호 Auth',
    approved: '승인 APPROVED',
    copy: 'Customer copy',
    orderNo: '주문번호 Order No.',
    orderDate: '주문일 Order date',
    summary: '주문 내역 Order summary',
    title: '거래명세서 INVOICE',
    pageFooter: '- 2 -',
  },
}

const TEMPLATE_LABELS: Partial<Record<Template, Record<Language, Partial<Labels>>>> = {
  'email-order': { en: { total: 'Order total' }, ko: { total: '총 결제금액' }, mixed: { total: '총 결제금액 (Total)' } },
  'invoice-table': { en: { total: 'Total' }, ko: { total: '합계금액' }, mixed: { total: '합계 Total' } },
  'card-slip': { en: { total: 'TOTAL' }, ko: { total: '결제금액' }, mixed: { total: '합계 TOTAL' } },
}

export function resolveLabels(seed: Seed): Labels {
  return {
    ...LABELS[seed.language],
    ...TEMPLATE_LABELS[seed.template]?.[seed.language],
    ...seed.render.labels,
  }
}

function monthName(month: number): string {
  const name = MONTH_LONG[month - 1]
  if (name === undefined) throw new Error(`not a month: ${month}`)
  return name
}

export function formatDate(iso: string, pattern: DateFormat): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!match) throw new Error(`not an ISO date: ${iso}`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const two = (n: number) => String(n).padStart(2, '0')
  return pattern.replace(/YYYY|YY|MMMM|MMM|MM|M|DD|D/g, (token) => {
    switch (token) {
      case 'YYYY':
        return String(year)
      case 'YY':
        return two(year % 100)
      case 'MMMM':
        return monthName(month)
      case 'MMM':
        return monthName(month).slice(0, 3)
      case 'MM':
        return two(month)
      case 'M':
        return String(month)
      case 'DD':
        return two(day)
      default:
        return String(day)
    }
  })
}

export function formatNumber(n: number, key: NumberFormat): string {
  const spec: NumberFormatSpec = NUMBER_FORMATS[key]
  const [intPart = '', frac] = Math.abs(n).toFixed(spec.decimals).split('.')
  const grouped = spec.group ? intPart.replace(/\B(?=(\d{3})+(?!\d))/g, spec.group) : intPart
  return (n < 0 ? '-' : '') + grouped + (frac ? spec.decimal + frac : '')
}

export function formatMoney(n: number, currency: Currency, numberFormat: NumberFormat, position: SymbolPosition): string {
  const body = formatNumber(Math.abs(n), numberFormat)
  let out = body
  if (position !== 'none') {
    const symbols = CURRENCIES[currency]
    out = position === 'prefix' ? symbols.pre + symbols.preSp + body : body + symbols.sufSp + symbols.suf
  }
  return n < 0 ? `-${out}` : out
}

const r2 = (x: number): number => Math.round(x * 100) / 100

function hash(str: string, mod: number): number {
  let h = 5381
  for (const ch of str) h = ((h << 5) + h + (ch.codePointAt(0) ?? 0)) >>> 0
  return h % mod
}

export function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6)
    w += wide ? 2 : 1
  }
  return w
}

const padL = (s: string, n: number): string => ' '.repeat(Math.max(0, n - displayWidth(s))) + s
const center = (s: string, w: number): string => ' '.repeat(Math.max(0, Math.floor((w - displayWidth(s)) / 2))) + s
const row = (left: string, right: string, w: number): string => left + ' '.repeat(Math.max(1, w - displayWidth(left) - displayWidth(right))) + right
const rule = (ch: string, w: number): string => ch.repeat(w)
const jag = (w: number): string => '/\\'.repeat(Math.ceil(w / 2)).slice(0, w)
const lineTotal = (li: LineItem): number => r2(li.qty * li.unitPrice)

type SeedData = Seed['data']
type SeedRender = Seed['render']

interface SlotOptions {
  center?: boolean
  width?: number
}

interface PaymentOptions {
  auth?: boolean
}

interface Context {
  seed: Seed
  d: SeedData
  r: SeedRender
  L: Labels
  show: (field: Omittable) => boolean
  prices: boolean
  num: (n: number) => string
  money: (n: number) => string
  dateStr: string | null
  timeStr: string | null
  cardLike: boolean
  receiptNo: string
  auth: string
  slot: (name: Slot, options?: SlotOptions) => string[]
  dateLines: () => string[]
  summary: (options?: { netRows?: boolean }) => [string, string][]
  paymentLines: (w: number, options?: PaymentOptions) => string[]
  itemBlocks: (format: (li: LineItem, total: number) => string[]) => string[][]
}

function makeContext(seed: Seed): Context {
  const d = seed.data
  const r = seed.render
  const L = resolveLabels(seed)
  const omit = new Set<Omittable>(r.omit ?? [])
  const show = (field: Omittable): boolean => !omit.has(field)
  const prices = show('prices')
  const num = (n: number): string => formatNumber(n, r.numberFormat)
  const money = (n: number): string => formatMoney(n, d.currency, r.numberFormat, r.currencySymbolPosition)
  const injection = seed.difficulty === 'adversarial' && seed.injection ? seed.injection.split('\n') : []
  const dateStr = show('date') && d.date ? formatDate(d.date, r.dateFormat) : null
  const timeStr = show('time') && d.time ? d.time : null
  const cardLike = /card|카드|visa|master/i.test(d.paymentMethod ?? '')

  const ctx: Context = {
    seed,
    d,
    r,
    L,
    show,
    prices,
    num,
    money,
    dateStr,
    timeStr,
    cardLike,
    receiptNo: String(hash(`${seed.id}#receipt`, 1e6)).padStart(6, '0'),
    auth: String(hash(`${seed.id}#auth`, 1e8)).padStart(8, '0'),
    slot(name, { center: doCenter = false, width = 0 } = {}) {
      const out = (r.extra?.[name] ?? []).map((l) => (doCenter ? center(l, width) : l))
      if (r.injectionPosition === name) out.push(...injection)
      return out
    },
    dateLines() {
      const out: string[] = []
      if (dateStr) out.push(`${L.date}: ${dateStr}${timeStr ? `  ${timeStr}` : ''}`)
      else if (timeStr) out.push(`${L.time}: ${timeStr}`)
      if (dateStr && r.dateHint) out.push(r.dateHint)
      return out
    },
    summary({ netRows = false } = {}) {
      if (!prices) return []
      const out: [string, string][] = []
      if (show('subtotal') && d.subtotal != null && d.total != null && d.subtotal !== d.total) {
        out.push([L.subtotal, money(d.subtotal)])
      }
      if (show('discount') && d.discount) out.push([L.discount, money(-d.discount)])
      if (show('tax') && d.tax != null) {
        if (r.taxInclusive && netRows) {
          out.push([L.net, money(r2((d.subtotal ?? 0) - (d.discount ?? 0) - d.tax))])
          out.push([L.tax, money(d.tax)])
        } else {
          out.push([r.taxInclusive ? L.taxIncl : L.tax, money(d.tax)])
        }
      }
      if (show('tip') && d.tip) out.push([L.tip, money(d.tip)])
      if (show('total') && d.total != null) out.push([L.total, money(d.total)])
      return out
    },
    paymentLines(w, { auth = true } = {}) {
      const out: string[] = []
      if (show('payment') && d.paymentMethod) {
        out.push(`${L.payment}: ${d.paymentMethod}`)
        if (auth && cardLike) out.push(`${L.approval}: ${ctx.auth}`)
      }
      if (prices && show('total') && show('change') && d.change != null && d.total != null) {
        out.push(row(L.cashIn, money(r2(d.total + d.change)), w))
        out.push(row(L.change, money(d.change), w))
      }
      return out
    },
    itemBlocks(format) {
      const blocks = d.lines.map((li) => format(li, lineTotal(li)))
      if (injection.length > 0 && r.injectionPosition === 'items') {
        blocks.splice(Math.min(1, blocks.length), 0, injection)
      }
      return blocks
    },
  }
  return ctx
}

interface Parts {
  head: string[]
  items: string[][]
  foot: string[]
}

function assemble(parts: Parts, c: Context, w: number): string[] {
  let { head, items, foot } = parts
  const torn = c.r.torn
  if (torn?.edge === 'top') {
    head = [jag(w)]
    items = items.slice(torn.dropItems)
  } else if (torn?.edge === 'bottom') {
    const kept = items.slice(0, torn.keepItems)
    const next = c.d.lines[torn.keepItems]
    if (next) kept.push([next.name.slice(0, Math.max(2, Math.ceil(next.name.length / 2)))])
    items = kept
    foot = [jag(w)]
  }
  return [...head, ...items.flat(), ...foot]
}

function thermal(c: Context): string[] {
  const w = 40
  const { d, L } = c
  const head: string[] = []
  if (c.show('vendor') && d.vendor) head.push(center(d.vendor, w))
  head.push(...c.slot('header', { center: true, width: w }))
  head.push(...c.dateLines())
  head.push(...c.slot('meta'))
  head.push(rule('-', w))
  const items = c.itemBlocks((li, lt) => {
    if (!c.prices) return [row(li.name, `x${li.qty}`, w)]
    const first = row(li.name, c.num(lt), w)
    return li.qty === 1 ? [first] : [first, `  ${li.qty} x ${c.num(li.unitPrice)}`]
  })
  const foot = [rule('-', w), ...c.slot('beforeTotals')]
  foot.push(...c.summary().map(([k, v]) => row(k, v, w)))
  foot.push(...c.slot('afterTotals'))
  foot.push(...c.paymentLines(w))
  foot.push(...c.slot('footer'))
  if (L.thanks) foot.push('', center(L.thanks, w))
  return assemble({ head, items, foot }, c, w)
}

function krPos(c: Context): string[] {
  const w = 42
  const { d, L } = c
  const head = [`[${L.receipt}]`]
  if (c.show('vendor') && d.vendor) head.push(`${L.vendor}: ${d.vendor}`)
  head.push(...c.slot('header'))
  head.push(...c.dateLines())
  head.push(`${L.receiptNo}: ${c.receiptNo}`)
  head.push(...c.slot('meta'))
  head.push(rule('=', w))
  const cols = (u: string, q: string, a: string): string => padL(u, 10) + padL(q, 6) + padL(a, 12)
  if (c.prices) head.push(row(L.item, cols(L.price, L.qty, L.amount), w))
  else head.push(row(L.item, padL(L.qty, 6), w))
  head.push(rule('-', w))
  const items = c.itemBlocks((li, lt) => {
    if (!c.prices) return [row(li.name, padL(String(li.qty), 6), w)]
    return [li.name, padL(cols(c.num(li.unitPrice), String(li.qty), c.num(lt)), w)]
  })
  const foot = [rule('-', w), ...c.slot('beforeTotals')]
  foot.push(...c.summary({ netRows: true }).map(([k, v]) => row(k, v, w)))
  foot.push(...c.slot('afterTotals'))
  foot.push(...c.paymentLines(w))
  foot.push(...c.slot('footer'))
  if (L.thanks) foot.push('', center(L.thanks, w))
  return assemble({ head, items, foot }, c, w)
}

function cardSlip(c: Context): string[] {
  const w = 40
  const { d, L } = c
  const head: string[] = []
  if (c.show('vendor') && d.vendor) head.push(center(d.vendor, w))
  head.push(...c.slot('header', { center: true, width: w }))
  head.push(...c.dateLines())
  head.push(`${L.receiptNo}: ${c.receiptNo}`)
  head.push(...c.slot('meta'))
  head.push(rule('-', w))
  const items = c.itemBlocks((li, lt) => {
    if (!c.prices) return [`${li.qty} ${li.name}`]
    return [row(`${li.qty} ${li.name}`, c.num(lt), w)]
  })
  const foot = [rule('-', w), ...c.slot('beforeTotals')]
  foot.push(...c.summary().map(([k, v]) => row(k, v, w)))
  foot.push(rule('-', w))
  foot.push(...c.paymentLines(w))
  if (c.show('total') && c.prices) foot.push(center(L.approved, w))
  foot.push(...c.slot('afterTotals'))
  foot.push(center(L.copy, w))
  foot.push(...c.slot('footer'))
  if (L.thanks) foot.push('', center(L.thanks, w))
  return assemble({ head, items, foot }, c, w)
}

function invoiceTable(c: Context): string[] {
  const w = 72
  const { d, L } = c
  const head: string[] = []
  head.push(c.show('vendor') && d.vendor ? row(d.vendor, L.title, w) : padL(L.title, w))
  head.push(...c.slot('header'))
  head.push(padL(`${L.receiptNo} ${c.receiptNo}`, w))
  head.push(...c.dateLines())
  head.push(...c.slot('meta'))
  head.push(rule('=', w))
  const cols = (q: string, u: string, a: string): string => padL(q, 6) + padL(u, 14) + padL(a, 16)
  head.push(row(L.item, cols(L.qty, L.price, L.amount), w))
  head.push(rule('-', w))
  const items = c.itemBlocks((li, lt) => {
    if (!c.prices) return [row(li.name, padL(String(li.qty), 6), w)]
    return [row(li.name, cols(String(li.qty), c.num(li.unitPrice), c.num(lt)), w)]
  })
  const foot = [rule('-', w), ...c.slot('beforeTotals')]
  foot.push(...c.summary().map(([k, v]) => `${' '.repeat(36)}${row(k, v, 36)}`))
  foot.push(...c.slot('afterTotals'))
  if (c.show('payment') && d.paymentMethod) foot.push('', `${L.paidBy}: ${d.paymentMethod}`)
  foot.push(...c.slot('footer'))
  if (L.thanks) foot.push('', L.thanks)
  return assemble({ head, items, foot }, c, w)
}

function emailOrder(c: Context): string[] {
  const w = 64
  const { d, L, seed } = c
  const named = c.show('vendor') ? d.vendor : null
  let subject: string
  if (seed.language === 'ko') subject = named ? `제목: [${named}] 주문이 완료되었습니다` : '제목: 주문이 완료되었습니다'
  else if (seed.language === 'mixed') {
    subject = named ? `제목: [${named}] 주문 완료 / Order confirmation` : '제목: 주문 완료 / Order confirmation'
  } else subject = named ? `Subject: Your order from ${named} is confirmed` : 'Subject: Your order is confirmed'
  const head = [subject, 'From: orders@shop.example', '']
  if (named) head.push(named)
  head.push(...c.slot('header'))
  head.push(L.thanks, '')
  head.push(`${L.orderNo}: ${c.receiptNo}`)
  if (c.dateStr) head.push(`${L.orderDate}: ${c.dateStr}`)
  if (c.dateStr && c.r.dateHint) head.push(c.r.dateHint)
  if (c.show('payment') && d.paymentMethod) head.push(`${L.payment}: ${d.paymentMethod}`)
  head.push(...c.slot('meta'))
  head.push('', L.summary, rule('-', w))
  const items = c.itemBlocks((li, lt) => {
    if (!c.prices) return [`${li.qty} x ${li.name}`]
    return [row(`${li.qty} x ${li.name}`, c.money(lt), w)]
  })
  const foot = [rule('-', w), ...c.slot('beforeTotals')]
  foot.push(...c.summary().map(([k, v]) => row(k, v, w)))
  foot.push(...c.slot('afterTotals'))
  foot.push(...c.slot('footer'))
  return assemble({ head, items, foot }, c, w)
}

function plainDoc(c: Context): string[] {
  const lines = [...(c.d.body ?? [])]
  if (lines.length === 0) {
    for (let i = 0; i < 14; i += 1) lines.push('')
    lines.push(center(c.L.pageFooter, 40))
  }
  lines.push(...c.slot('footer'))
  return lines
}

const BUILDERS: Record<Template, (c: Context) => string[]> = {
  thermal,
  'kr-pos': krPos,
  'card-slip': cardSlip,
  'invoice-table': invoiceTable,
  'email-order': emailOrder,
  'plain-doc': plainDoc,
}

export function renderText(seed: Seed): string {
  const build = BUILDERS[seed.template]
  return `${build(makeContext(seed)).join('\n')}\n`
}
