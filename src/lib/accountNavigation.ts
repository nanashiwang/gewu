/** Public account pages share the detector shell; the existing platform keeps its own navigation. */
export function isDetectorAccountPath(pathname: string): boolean {
  return (
    ['/login', '/register', '/account'].includes(pathname) ||
    pathname === '/console/relays' ||
    pathname.startsWith('/console/relays/')
  )
}

export const ACCOUNT_HOME = '/account'
