import { getContext, setContext } from "svelte"
import type { SupatypeClient, AnyDatabase } from "@supatype/client"

const SUPATYPE_KEY = Symbol("supatype")

export function setSupatypeClient(client: SupatypeClient): void {
  setContext(SUPATYPE_KEY, client)
}

export function getSupatypeClient<TDatabase extends AnyDatabase = AnyDatabase>(): SupatypeClient<TDatabase> {
  const client = getContext<SupatypeClient<TDatabase> | undefined>(SUPATYPE_KEY)
  if (!client) {
    throw new Error("getSupatypeClient() requires setSupatypeClient() to be called in a parent component.")
  }
  return client
}
