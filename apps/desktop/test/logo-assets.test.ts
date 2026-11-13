// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DOT_NODE, DROP_PATH, SPLIT_NODES, SPLIT_PATHS } from '../src/app/logo-geometry'
import { TRAY_ICON_DATA_URL } from '../src/main/tray'

const BUILD = join(import.meta.dirname, '../build')
const read = (name: string) => readFileSync(join(BUILD, name), 'utf8')

describe('logo assets', () => {
  it('keeps icon.svg in step with the geometry the app draws', () => {
    const svg = read('icon.svg')
    expect(svg).toContain(`d="${DROP_PATH}"`)
    for (const d of SPLIT_PATHS) expect(svg).toContain(`d="${d}"`)
    for (const node of SPLIT_NODES) expect(svg).toContain(`<circle cx="${node.cx}" cy="${node.cy}" r="${node.r}"`)
  })

  it('keeps icon-small.svg to the drop and one dot', () => {
    const svg = read('icon-small.svg')
    expect(svg).toContain(`d="${DROP_PATH}"`)
    expect(svg).toContain(`<circle cx="${DOT_NODE.cx}" cy="${DOT_NODE.cy}" r="${DOT_NODE.r}"`)
    for (const d of SPLIT_PATHS) expect(svg).not.toContain(d)
  })

  it('keeps tray.svg a single-colour drop with the dot cut out', () => {
    const svg = read('tray.svg')
    expect(svg).toContain(DROP_PATH)
    expect(svg).toContain('fill-rule="evenodd"')
    expect(svg).not.toMatch(/url\(#|stop-color|gradient/i)
  })

  it('ships a 1024 px PNG and an icns file', () => {
    const png = readFileSync(join(BUILD, 'icon.png'))
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(png.readUInt32BE(16)).toBe(1024)
    expect(png.readUInt32BE(20)).toBe(1024)
    const icns = readFileSync(join(BUILD, 'icon.icns'))
    expect(icns.subarray(0, 4).toString('latin1')).toBe('icns')
    expect(icns.readUInt32BE(4)).toBe(icns.length)
  })

  it('draws the tray icon as a 32 px PNG with transparency', () => {
    const bytes = Buffer.from(TRAY_ICON_DATA_URL.split(',')[1]!, 'base64')
    expect(bytes.readUInt32BE(16)).toBe(32)
    expect(bytes.readUInt32BE(20)).toBe(32)
    expect(bytes[25]).toBe(6)
  })

  it('points electron-builder at the icns file', () => {
    const config = readFileSync(join(import.meta.dirname, '../electron-builder.yml'), 'utf8')
    expect(config).toMatch(/^ {2}icon: build\/icon\.icns$/m)
  })
})
