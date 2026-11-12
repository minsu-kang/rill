function nested(depth: number): unknown {
  let value: unknown = 'bottom'
  for (let level = 0; level < depth; level += 1) value = { level, inner: value }
  return value
}

export function hostileValue(): unknown {
  return {
    html: '<img src=x onerror="window.__pwned = 1">',
    script: '<script>window.__pwned = 1</script>',
    link: '<a href="javascript:window.__pwned = 1">open</a>',
    reference: '{{extract.output.secret}}',
    long: 'A'.repeat(100_000),
    nested: nested(60),
    big: Array.from({ length: 10_000 }, (_, index) => index),
    reversed: 'invoice ‮txt.exe',
    quote: '"><svg onload=alert(1)>',
    own: JSON.parse('{"__proto__": {"polluted": true}, "constructor": "x"}') as unknown,
  }
}
