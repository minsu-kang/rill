import axe from 'axe-core'

export async function violations(root: HTMLElement): Promise<string[]> {
  const result = await axe.run(root, { rules: { 'color-contrast': { enabled: false } } })
  return result.violations.map((found) => `${found.id}: ${found.nodes.map((item) => item.target.join(' ')).join(', ')}`)
}
