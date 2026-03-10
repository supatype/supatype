import React from "react"
import type { SupatypeClient, AnyDatabase } from "@supatype/client"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const SupatypeContext = React.createContext<SupatypeClient<any> | null>(null)

export interface SupatypeProviderProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: SupatypeClient<any>
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
export function useSupatype<TDatabase extends AnyDatabase = AnyDatabase>(): SupatypeClient<TDatabase> {
  const client = React.useContext(SupatypeContext) as SupatypeClient<TDatabase> | null
  if (client === null) {
    throw new Error("useSupatype must be used inside a <SupatypeProvider>")
  }
  return client
}
