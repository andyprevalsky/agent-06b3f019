/**
 * STATE MACHINE: useIsMobile
 *
 * [UNKNOWN] <-- isMobile: undefined (initial)
 *     |
 *     v (useEffect measures window)
 * [MOBILE] <-- isMobile: true (width < 768px)
 *   or
 * [DESKTOP] <-- isMobile: false (width >= 768px)
 *     |
 *     | (window resize event)
 *     v
 * [MOBILE] or [DESKTOP]
 *
 * Returns boolean indicating mobile viewport.
 */

import * as React from "react"

const MOBILE_BREAKPOINT = 768

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    mql.addEventListener("change", onChange)
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return !!isMobile
}
