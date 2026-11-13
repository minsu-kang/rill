function isHidden(element: HTMLElement): boolean {
  const view = element.ownerDocument.defaultView
  if (view === null) return true
  if (element.closest('[hidden], [inert]') !== null) return true
  const { visibility } = view.getComputedStyle(element)
  if (visibility === 'hidden' || visibility === 'collapse') return true
  for (let node: HTMLElement | null = element; node !== null; node = node.parentElement) {
    if (view.getComputedStyle(node).display === 'none') return true
  }
  return false
}

function focusIsNowhere(active: Element | null, doc: Document): boolean {
  return active === null || active === doc.body || active === doc.documentElement
}

export function canRestoreFocus(element: HTMLElement | null, active: Element | null): element is HTMLElement {
  if (element === null || !element.isConnected) return false
  if (!focusIsNowhere(active, element.ownerDocument)) return false
  if (element.matches(':disabled')) return false
  return !isHidden(element)
}
