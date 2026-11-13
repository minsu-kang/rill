export function typeInto(field: HTMLInputElement | HTMLTextAreaElement | null, text: string): void {
  if (field === null) return
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, text)
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function chooseOption(select: HTMLSelectElement | null, value: string): void {
  if (select === null) return
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
}
