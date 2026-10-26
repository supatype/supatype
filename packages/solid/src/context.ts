import { createContext, useContext } from "solid-js"
import type { AugmentedDatabase, AnyClient, AnyDatabase, SupatypeClient } from "@supatype/client"
import { isClientFor } from "@supatype/client/bindings"

/** Typed at `AnyClient`, narrowed on read. See `AnyClient` for why it is neither generic nor `any`. */
export const SupatypeContext = createContext<AnyClient>()

export function useSupatype<TDatabase extends AnyDatabase = AugmentedDatabase>(): SupatypeClient<TDatabase> {
  const client = useContext(SupatypeContext)
  if (!client || !isClientFor<TDatabase>(client)) {
    throw new Error("useSupatype() requires a <SupatypeContext.Provider> ancestor.")
  }
  return client
}
