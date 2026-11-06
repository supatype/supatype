/**
 * `run`, one at a time. A trigger while a run is in flight asks for one more run after it, however
 * many triggers came in, as docker dev's push queue does. A run that fails goes to `onError` and the
 * run asked for during it still happens. A trigger's promise settles once the runs it joined are done.
 */
export function serialRuns(run: () => Promise<void>, onError: (err: unknown) => void): () => Promise<void> {
  let inFlight: Promise<void> | undefined
  let again = false
  const drain = async (): Promise<void> => {
    try {
      do {
        again = false
        await run().catch(onError)
      } while (again)
    } finally {
      inFlight = undefined
    }
  }
  return () => {
    if (inFlight !== undefined) {
      again = true
      return inFlight
    }
    inFlight = drain()
    return inFlight
  }
}
