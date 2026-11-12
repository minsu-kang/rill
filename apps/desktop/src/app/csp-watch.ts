export const CSP_ATTRIBUTE = 'data-rill-csp-violations'

export function watchCspViolations(doc: Document = document): () => number {
  let count = 0
  const publish = (): void => {
    doc.documentElement.setAttribute(CSP_ATTRIBUTE, String(count))
  }
  doc.addEventListener('securitypolicyviolation', () => {
    count += 1
    publish()
  })
  publish()
  return () => count
}
