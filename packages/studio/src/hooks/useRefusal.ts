import { useCallback, useState } from "react"
import type { RefusalReport } from "../lib/write-error.js"

/** What went wrong with the last save: the banner's line, its details, and each input's message. */
export interface Refusal extends RefusalReport {
  error: string | null
  details: string | null
  fieldErrors: Record<string, string>
}

/**
 * A form's refusal state, shared by every editor so each reports a refused save the same way.
 *
 * A new banner line drops the last one's details: they belonged to it. A refusal sets its own
 * details after its line (`reportRefusal`), so they survive.
 */
export function useRefusal(initialFieldErrors: Record<string, string> = {}): Refusal {
  const [error, setErrorLine] = useState<string | null>(null)
  const [details, setDetails] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>(initialFieldErrors)
  const setError = useCallback((message: string | null) => {
    setErrorLine(message)
    setDetails(null)
  }, [])
  return { error, details, fieldErrors, setError, setDetails, setFieldErrors }
}
