import { createContext, useContext } from "react"
import type { AdminConfig } from "../config.js"

export const AdminConfigContext = createContext<AdminConfig | null>(null)

export function useAdminConfig(): AdminConfig {
  const config = useContext(AdminConfigContext)
  if (!config) {
    throw new Error("useAdminConfig must be used within an AdminConfigProvider")
  }
  return config
}
