import { createContext, useContext } from "react"

export const CloudUrlContext = createContext<string | undefined>(undefined)

/** Returns the Supatype Cloud marketing URL, or undefined in self-hosted mode. */
export function useCloudUrl(): string | undefined {
  return useContext(CloudUrlContext)
}
