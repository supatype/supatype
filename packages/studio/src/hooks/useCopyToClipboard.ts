import { useCallback, useEffect, useRef, useState } from "react"

/** How long a copy button says "Copied" before it goes back to its label. */
const COPIED_FOR_MS = 2000

/**
 * Copies text to the clipboard and reports `copied` for a moment afterwards, for a copy button's
 * label or icon. A refused clipboard write leaves `copied` false rather than claiming success, and
 * the reset timer is cleared on unmount so it never sets state on a component that has gone.
 */
export function useCopyToClipboard(): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current)
  }, [])

  const copy = useCallback((text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      if (timer.current !== null) clearTimeout(timer.current)
      setCopied(true)
      timer.current = setTimeout(() => setCopied(false), COPIED_FOR_MS)
    }).catch(() => undefined)
  }, [])

  return { copied, copy }
}
