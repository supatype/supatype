import { createContext, useContext } from "solid-js"
import type { AnyClient, AnyDatabase, SupatypeClient } from "@supatype/client"

/** Typed at `AnyClient`, narrowed on read. See `AnyClient` for why it is neither generic nor `any`. */
export const SupatypeContext = createContext<AnyClient>()

export function useSupatype<TDatabase extends AnyDatabase = AnyDatabase>(): SupatypeClient<TDatabase> {
  const client = useContext(SupatypeContext)
  if (!client) {
    throw new Error("useSupatype() requires a <SupatypeContext.Provider> ancestor.")
  }
  return client as SupatypeClient<TDatabase>
}
