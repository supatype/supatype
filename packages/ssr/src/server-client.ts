import { createClient } from "@supatype/client"
import type { SupatypeClient, AnyDatabase } from "@supatype/client"
import { parseSessionFromCookies } from "./cookie-parser.js"
import type { ServerClientOptions } from "./types.js"

export function createServerClient<TDatabase extends AnyDatabase = AnyDatabase>(
  url: string,
  anonKey: string,
  options: ServerClientOptions,
): SupatypeClient<TDatabase> {
  const session = parseSessionFromCookies(options.cookies.getAll(), options.cookiePrefix)
  return createClient<TDatabase>({
    url,
    anonKey,
    ...(session !== null && { initialSession: session }),
  })
}
