import { useCallback, useState } from "react"
import { useProjectProxy, type StudioAdminSchema } from "./useProjectProxy.js"

export interface PolicyWrites {
  /** The last write's failure, cleared when the next write starts. */
  writeError: string | null
  /** Runs one write and then `onChange`; a failure lands in `writeError` instead. */
  run: (write: () => Promise<unknown>) => Promise<void>
  /** Switches RLS on an auth or storage table through `/studio-admin/rls`. */
  toggleRls: (schema: StudioAdminSchema, table: string, enable: boolean) => Promise<void>
  /** Drops a policy on an auth or storage table through `/studio-admin/policies`, once confirmed. */
  dropPolicy: (schema: StudioAdminSchema, table: string, name: string) => Promise<void>
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * The RLS and policy writes the Policies views make on auth and storage tables (SQ2). The SQL
 * editor's login cannot alter those tables, so these go through the allow-listed admin routes.
 */
export function usePolicyWrites(onChange: () => void): PolicyWrites {
  const proxy = useProjectProxy()
  const [writeError, setWriteError] = useState<string | null>(null)

  const run = useCallback(async (write: () => Promise<unknown>): Promise<void> => {
    setWriteError(null)
    try {
      await write()
      onChange()
    } catch (e) {
      setWriteError(messageOf(e))
    }
  }, [onChange])

  const toggleRls = useCallback(
    (schema: StudioAdminSchema, table: string, enable: boolean) => run(() => proxy.studioRls(schema, table, enable)),
    [proxy, run],
  )

  const dropPolicy = useCallback(async (schema: StudioAdminSchema, table: string, name: string): Promise<void> => {
    if (!window.confirm(`Drop policy ${name} on ${schema}.${table}?`)) return
    await run(() => proxy.studioPolicy({ schema, table, op: "drop", name }))
  }, [proxy, run])

  return { writeError, run, toggleRls, dropPolicy }
}
