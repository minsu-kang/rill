export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  'connect-src ws://127.0.0.1:* ws://localhost:*',
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ')

const META = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`

export function injectCsp(html: string): string {
  if (html.includes(META)) return html
  if (!html.includes('<head>')) throw new Error('the page needs a plain <head> tag to carry the content security policy')
  return html.replace('<head>', `<head>${META}`)
}
