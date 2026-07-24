import type { Database } from "./database"

declare module "@supatype/client" {
  interface SupatypeModels {
    note: Database["public"]["Tables"]["note"]
  }
}

export {}
