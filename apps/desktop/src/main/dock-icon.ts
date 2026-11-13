export interface DockIconDeps {
  platform: string
  isPackaged: boolean
  dock: { setIcon(image: unknown): void } | undefined
  iconPath: string
  exists(path: string): boolean
  createFromPath(path: string): { isEmpty(): boolean }
}

export function applyDevDockIcon(deps: DockIconDeps): boolean {
  if (deps.platform !== 'darwin' || deps.isPackaged || deps.dock === undefined) return false
  if (!deps.exists(deps.iconPath)) return false
  const image = deps.createFromPath(deps.iconPath)
  if (image.isEmpty()) return false
  deps.dock.setIcon(image)
  return true
}
