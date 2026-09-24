/**
 * Supatype Vue plugin and injection key.
 *
 * @example
 * ```ts
 * import { createApp } from 'vue'
 * import { createClient } from '@supatype/client'
 * import { supatypePlugin } from '@supatype/vue'
 *
 * const supatype = createClient({ url: '...', anonKey: '...' })
 * const app = createApp(App)
 * app.use(supatypePlugin, supatype)
 * ```
 */

import { inject, type InjectionKey, type Plugin } from "vue"
import type { AnyClient, SupatypeClient, AnyDatabase } from "@supatype/client"

/** Typed at `AnyClient`, narrowed on read. See `AnyClient` for why it is neither generic nor `any`. */
export const SUPATYPE_KEY: InjectionKey<AnyClient> = Symbol("supatype")

/**
 * Vue plugin that provides the Supatype client to all components.
 *
 * Declared with its options tuple rather than a bare `Plugin`, whose options default to `any[]`:
 * with that default `app.use(supatypePlugin, somethingElse)` was accepted at compile time and threw
 * on the first `useSupatype()` instead.
 */
export const supatypePlugin: Plugin<[AnyClient]> = {
  install(app, client) {
    app.provide(SUPATYPE_KEY, client)
  },
}

/**
 * Get the Supatype client from the injection context.
 * Must be called inside setup() of a component that has the supatypePlugin installed.
 */
export function useSupatype<TDatabase extends AnyDatabase = AnyDatabase>(): SupatypeClient<TDatabase> {
  const client = inject(SUPATYPE_KEY)
  if (!client) {
    throw new Error("useSupatype() requires the supatypePlugin to be installed on the Vue app.")
  }
  return client as SupatypeClient<TDatabase>
}
