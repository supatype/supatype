import { createContext, useContext } from "solid-js"
import type { SupatypeClient, AnyDatabase } from "@supatype/client"

export const SupatypeContext = createContext<SupatypeClient>()

export function useSupatype<TDatabase extends AnyDatabase = AnyDatabase>(): SupatypeClient<TDatabase> {
  const client = useContext(SupatypeContext)
  if (!client) {
    throw new Error("useSupatype() requires a <SupatypeContext.Provider> ancestor.")
  }
  return client as SupatypeClient<TDatabase>
}
