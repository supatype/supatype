import { createContext, useContext } from "react"

/**
 * What a host tells Studio about how an app reaches this project: the public API URL and the anon
 * key. Both are public, and both are what the Connect panel prints into an app's env file. It is
 * not `client.url`, which in Cloud is the control-plane proxy path. A service role key has no
 * place here.
 */
export interface ProjectConnection {
  apiUrl?: string | undefined
  anonKey?: string | undefined
}

export const ConnectionCtx = createContext<ProjectConnection | undefined>(undefined)

export function useConnection(): ProjectConnection | undefined {
  return useContext(ConnectionCtx)
}
