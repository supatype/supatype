import { NextResponse } from "next/server"
import { createClient } from "@/lib/supatype-server"

/**
 * The same read, as JSON, through a Route Handler.
 *
 * Here to prove `@supatype/ssr` works outside a Server Component: the cookie-derived session is
 * what decides what this returns, so an editor calling it gets their drafts and a stranger gets
 * what is published, with no branch in this file saying so.
 */
export async function GET(): Promise<NextResponse> {
  const supatype = await createClient()
  const { data, error } = await supatype
    .from("talk")
    .select("id,title,slug,starts_at")
    .order("starts_at", { ascending: true })
    .limit(50)

  if (error !== null) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ talks: data ?? [] })
}
