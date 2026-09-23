import { createContext, useContext } from "solid-js"
import type { SupatypeClient, AnyDatabase } from "@supatype/client"

/**
 * Widened for the same reason `@supatype/react`'s context is: `SupatypeClient<TDatabase>` is
 * invariant in its database, so a context typed at the default rejects the typed client every real
 * project builds with `createClient<Database>(…)`. A provider is one value for many consumers and
 * cannot be generic, so the alternative is a cast at every `<Provider>`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const SupatypeContext = createContext<SupatypeClient<any>>()

export function useSupatype<TDatabase extends AnyDatabase = AnyDatabase>(): SupatypeClient<TDatabase> {
  const client = useContext(SupatypeContext)
  if (!client) {
    throw new Error("useSupatype() requires a <SupatypeContext.Provider> ancestor.")
  }
  return client as SupatypeClient<TDatabase>
}
