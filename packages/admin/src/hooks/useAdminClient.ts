import { createContext, useContext } from "react"
import type { SupatypeClient } from "@supatype/client"

export const AdminClientContext = createContext<SupatypeClient | null>(null)

export function useAdminClient(): SupatypeClient {
  const client = useContext(AdminClientContext)
  if (!client) {
    throw new Error("useAdminClient must be used within an AdminClientProvider")
  }
  return client
}
