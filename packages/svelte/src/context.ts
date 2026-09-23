import { getContext, setContext } from "svelte"
import type { SupatypeClient, AnyDatabase } from "@supatype/client"

const SUPATYPE_KEY = Symbol("supatype")

/**
 * Generic in the database, like its getter.
 *
 * It used to take a bare `SupatypeClient`, which defaults to `AugmentedDatabase`, so passing the
 * typed client a project actually has — `createClient<Database>(…)` — was a type error at the one
 * call every Svelte app makes. The only way through was a cast in user code, which then threw away
 * the row types the client was carrying.
 */
export function setSupatypeClient<TDatabase extends AnyDatabase = AnyDatabase>(
  client: SupatypeClient<TDatabase>,
): void {
  setContext(SUPATYPE_KEY, client)
}

export function getSupatypeClient<TDatabase extends AnyDatabase = AnyDatabase>(): SupatypeClient<TDatabase> {
  const client = getContext<SupatypeClient<TDatabase> | undefined>(SUPATYPE_KEY)
  if (!client) {
    throw new Error("getSupatypeClient() requires setSupatypeClient() to be called in a parent component.")
  }
  return client
}
