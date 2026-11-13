// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { applyDevDockIcon, type DockIconDeps } from '../src/main/dock-icon'

function make(over: Partial<DockIconDeps> = {}) {
  const setIcon = vi.fn()
  const image = { isEmpty: () => false }
  const deps: DockIconDeps = {
    platform: 'darwin',
    isPackaged: false,
    dock: { setIcon },
    iconPath: '/app/build/icon.png',
    exists: vi.fn(() => true),
    createFromPath: vi.fn(() => image),
    ...over,
  }
  return { deps, setIcon, image }
}

describe('dev dock icon', () => {
  it('sets the dock icon of an unpackaged app on macOS', () => {
    const { deps, setIcon, image } = make()
    expect(applyDevDockIcon(deps)).toBe(true)
    expect(deps.createFromPath).toHaveBeenCalledWith('/app/build/icon.png')
    expect(setIcon).toHaveBeenCalledWith(image)
  })

  it('does nothing for a packaged app, which has the icon in its bundle', () => {
    const { deps, setIcon } = make({ isPackaged: true })
    expect(applyDevDockIcon(deps)).toBe(false)
    expect(setIcon).not.toHaveBeenCalled()
  })

  it('does nothing off macOS or without a dock', () => {
    const linux = make({ platform: 'linux' })
    expect(applyDevDockIcon(linux.deps)).toBe(false)
    expect(linux.setIcon).not.toHaveBeenCalled()
    const noDock = make({ dock: undefined })
    expect(applyDevDockIcon(noDock.deps)).toBe(false)
  })

  it('does nothing when the file is missing or cannot be read as an image', () => {
    const missing = make({ exists: vi.fn(() => false) })
    expect(applyDevDockIcon(missing.deps)).toBe(false)
    expect(missing.deps.createFromPath).not.toHaveBeenCalled()
    const empty = make({ createFromPath: vi.fn(() => ({ isEmpty: () => true })) })
    expect(applyDevDockIcon(empty.deps)).toBe(false)
    expect(empty.setIcon).not.toHaveBeenCalled()
  })
})
