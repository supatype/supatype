import { useState, useEffect, useCallback, useRef } from "react"

export interface ApiQueryResult<T> {
  data: T | null
  loading: boolean
  error: string | null
  refetch: () => void
}

/**
 * Lightweight data-fetching hook that standardises loading/error/data state.
 * Automatically calls the fetcher when dependencies change.
 *
 * Only the latest request is applied. Each run takes a request id, and a response that arrives
 * after a newer request started is dropped, so a slow answer to an old filter cannot overwrite the
 * answer to the current one (a mounted flag alone did not do this: it was set back to true by the
 * next run, before the old response landed).
 */
export function useApiQuery<T>(
  fetcher: () => Promise<T>,
  deps: unknown[],
): ApiQueryResult<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const latestRef = useRef(0)
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const execute = useCallback(async () => {
    const request = ++latestRef.current
    const isLatest = (): boolean => mountedRef.current && latestRef.current === request
    setLoading(true)
    setError(null)
    try {
      const result = await fetcherRef.current()
      if (isLatest()) {
        setData(result)
      }
    } catch (err) {
      if (isLatest()) {
        setError(err instanceof Error ? err.message : "An unexpected error occurred")
      }
    } finally {
      if (isLatest()) {
        setLoading(false)
      }
    }
  }, deps) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void execute()
  }, [execute])

  return { data, loading, error, refetch: execute }
}
