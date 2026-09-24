"use client"

import React from "react"
import type { AnyClient, SupatypeClient, AnyDatabase, AugmentedDatabase } from "@supatype/client"

/** Typed at `AnyClient`, narrowed on read. See `AnyClient` for why it is neither generic nor `any`. */
export const SupatypeContext = React.createContext<AnyClient | null>(null)

export interface SupatypeProviderProps {
  client: AnyClient
  children: React.ReactNode
}

/**
 * Wrap your application with SupatypeProvider to make the client available
 * via all Supatype hooks.
 *
 * @example
 * ```tsx
 * const client = createClient({ url: '...', anonKey: '...' })
 *
 * function App() {
 *   return (
 *     <SupatypeProvider client={client}>
 *       <YourApp />
 *     </SupatypeProvider>
 *   )
 * }
 * ```
 */
export function SupatypeProvider({ client, children }: SupatypeProviderProps): React.ReactElement {
  return React.createElement(SupatypeContext.Provider, { value: client }, children)
}

/**
 * Access the Supatype client directly. Most callers should use the
 * higher-level hooks (useAuth, useQuery, useMutation) instead.
 */
export function useSupatype<TDatabase extends AnyDatabase = AugmentedDatabase>(): SupatypeClient<TDatabase> {
  const client = React.useContext(SupatypeContext) as SupatypeClient<TDatabase> | null
  if (client === null) {
    throw new Error("useSupatype must be used inside a <SupatypeProvider>")
  }
  return client
}
