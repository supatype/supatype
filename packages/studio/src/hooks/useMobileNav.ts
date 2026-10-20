import { useCallback, useEffect, useState } from "react"
import { useLocation } from "react-router-dom"

/** The phone-width menu that is open: the burger's primary menu, the section's own panel, or neither. */
export type MobileNavPanel = "primary" | "section"

export interface MobileNav {
  open: MobileNavPanel | null
  toggle: (panel: MobileNavPanel) => void
  close: () => void
}

/**
 * One slot for Studio's phone-width menus, so at most one is ever open.
 *
 * They were two independent flags drawing two overlays at the same place and depth. With the
 * section panel open, the burger opened the primary menu underneath it, and there was no way
 * back to the primary menu. Opening either now closes the other, and both close on navigation
 * and on Escape.
 */
export function useMobileNav(): MobileNav {
  const { pathname } = useLocation()
  const [open, setOpen] = useState<MobileNavPanel | null>(null)
  const close = useCallback(() => setOpen(null), [])
  const toggle = useCallback((panel: MobileNavPanel) => setOpen((current) => (current === panel ? null : panel)), [])

  useEffect(close, [pathname, close])

  useEffect(() => {
    if (open === null) return
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") close() }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open, close])

  return { open, toggle, close }
}
