export const LOGO_VIEWBOX = 512
export const DROP_PATH = 'M256 80 C256 80 136 214 136 304 a120 120 0 0 0 240 0 C376 214 256 80 256 80Z'
export const SPLIT_PATHS = ['M204 312 H236 C268 312 262 270 302 270', 'M236 312 C268 312 262 354 302 354'] as const
export const SPLIT_NODES = [
  { cx: 204, cy: 312, r: 24 },
  { cx: 304, cy: 270, r: 16 },
  { cx: 304, cy: 354, r: 16 },
] as const
export const SPLIT_STROKE = 15
export const DOT_NODE = { cx: 256, cy: 318, r: 34 } as const
export const SMALL_LOGO_MAX_SIZE = 24
