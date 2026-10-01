// Pages whose URL carries user content stay out of analytics: the same set
// the former per-route pages excluded, matched on the resolved path now that
// every dynamic route renders from one shell.
export function analyticsExcluded(asPath: string): boolean {
  const path = asPath.split(/[?#]/)[0].replace(/\/+$/, '') || '/'
  return (
    path === '/' ||
    path === '/newchat' ||
    /^\/(chat|share)(\/|$)/.test(path) ||
    /^\/project\/[^/]+\/chat(\/|$)/.test(path)
  )
}
