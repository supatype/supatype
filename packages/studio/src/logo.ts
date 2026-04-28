/**
 * Server-safe logo exports — no hooks, no client-only APIs.
 * Import from "@supatype/studio/logo" in server components (Next.js RSC, etc.)
 * instead of the full "@supatype/studio" barrel which includes client components.
 */
export { SupatypeIcon, SupatypeWordmark } from "./components/SupatypeLogo.js"
