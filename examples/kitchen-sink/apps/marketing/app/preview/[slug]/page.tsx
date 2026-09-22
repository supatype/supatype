import React from "react"
import { createClient } from "@supatype/client"
import { LivePage } from "./live-page"
import type { Database } from "../../../../../supatype/generated/database"

type Page = Database["public"]["Tables"]["page"]["Row"]

const url = process.env["NEXT_PUBLIC_SUPATYPE_URL"] ?? "http://localhost:18473"
const anonKey = process.env["NEXT_PUBLIC_SUPATYPE_ANON_KEY"] ?? ""

/**
 * A page as it will read once published — both senses of "preview", together.
 *
 * Two different things get that name, and this example needs both because they answer different
 * questions:
 *
 *   - The **saved draft**, read here on the server with `.draft()` and a preview code. Works from
 *     anywhere, with no Studio open, for whoever holds the link.
 *   - **Unsaved keystrokes**, streamed from an open Studio tab into this page by `useLivePreview`
 *     in the client component below. Nothing is in the database yet.
 *
 * The code is the whole credential: it is exchanged for a short-lived token carrying a claim that
 * names this one record and no subject, so the database's own policy still decides. No service-role
 * key, and deliberately not the visitor's session — whoever opened the link may be signed in as
 * someone with no access to the draft, and using that identity would show them "not found".
 */
export default async function PreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ preview?: string }>
}): Promise<React.ReactElement> {
  const { slug } = await params
  const { preview: code } = await searchParams

  if (code === undefined || code === "") {
    return (
      <section>
        <h1>This page needs a preview link</h1>
        <p className="ks-muted">
          Open the page in Studio and use <b>Share a preview</b>. With Live Preview enabled, the
          editor also streams unsaved edits into this route as you type.
        </p>
      </section>
    )
  }

  const supatype = createClient<Database>({ url, anonKey, previewCode: code })
  const { data, error } = await supatype.from("page").draft().select().eq("slug", slug).limit(1)

  if (error !== null) {
    // An expired or revoked link. Said plainly rather than as "not found", which would send the
    // reader off to ask why the page had been deleted — while still not confirming a draft exists.
    return (
      <section>
        <h1>This preview link is no longer valid</h1>
        <p className="ks-muted">It may have expired, or been revoked. Ask for a new one.</p>
      </section>
    )
  }

  const page = (data as Page[] | null)?.[0] ?? null
  if (page === null) return <p className="ks-muted">No draft to preview.</p>

  return <LivePage initial={page} />
}
