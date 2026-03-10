import { createClient } from "@supatype/client"
import type { Database } from "@/types/database"

const url = process.env["NEXT_PUBLIC_SUPATYPE_URL"] ?? "http://localhost:8000"
const anonKey = process.env["NEXT_PUBLIC_SUPATYPE_ANON_KEY"] ?? ""

export const supatype = createClient<Database>({ url, anonKey })

// Re-export the Database type so components can import it from one place
export type { Database }
