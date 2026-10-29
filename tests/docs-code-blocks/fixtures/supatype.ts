/**
 * The reader's own client module. The docs create it once, as `src/supatype.ts`, and later
 * examples import it with `./supatype`, so the check puts this beside every written block.
 */
import { createClient } from "@supatype/client"

export const supatype = createClient({ url: "http://localhost:54321", anonKey: "anon-key" })
