import React from "react"
import { createClient } from "@supatype/client"
import type { AugmentedDatabase } from "@supatype/client"
import { RichText } from "@supatype/react"

type Post = AugmentedDatabase["public"]["Tables"]["post"]["Row"]

const url = process.env["NEXT_PUBLIC_SUPATYPE_URL"] ?? "http://localhost:18473"
const anonKey = process.env["NEXT_PUBLIC_SUPATYPE_ANON_KEY"] ?? ""

/**
 * A post as it will read once published, shown to someone holding a preview link.
 *
 * **The token is the whole credential.** It arrives as `?preview_token=…`, and this route sends it
 * as the request's `Authorization` header. There is no service-role key here and no session: the
 * link carries a claim naming this one record, and the database's own policy decides.
 *
 * That is the difference from the older way of doing this, which was to have the preview route hold
 * an admin key and fetch past the rules. Anyone who found this route could then read anything.
 *
 * Two different things get called preview, and this is the second:
 *
 *   - `useLivePreview` streams **unsaved keystrokes** out of an open Studio tab into an iframe.
 *   - This reads the **saved** draft, from the database, from anywhere, with no Studio open.
 */
export default async function PreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ preview_token?: string; locale?: string }>
}): Promise<React.ReactElement> {
  const { slug } = await params
  const { preview_token: token, locale } = await searchParams

  if (token === undefined || token === "") {
    return (
      <p className="error">
        This page needs a preview link. Open the post in Studio and use <b>Share a preview</b>.
      </p>
    )
  }

  // A fresh client per request, carrying the link as its whole credential rather than the visitor's
  // session. `previewToken` beats a session on purpose: whoever opened this link may be signed in
  // as someone with no access to the draft, and using that identity would show them "not found".
  const supatype = createClient<AugmentedDatabase>({ url, anonKey, previewToken: token })

  const { data: posts, error } = await supatype
    .from("post")
    .draft()
    .select()
    .eq("slug", slug)
    .limit(1)

  if (error !== null) {
    // Most likely an expired link, or one that was revoked. Say so rather than showing "not found",
    // which would send the reader to ask why the post had been deleted.
    return (
      <p className="error">
        This preview link is no longer valid. It may have expired, or been revoked. Ask for a new
        one.
      </p>
    )
  }

  const post: Post | null = posts?.[0] ?? null
  if (post === null) return <p className="empty">No draft to preview.</p>

  const language = locale ?? "en"
  // A localized column arrives as the whole locale record, so the page picks the language rather
  // than the API guessing at one. `Accept-Language` only feeds the cache key today.
  const body = (post.body as unknown as Record<string, unknown> | null)?.[language]

  return (
    <article>
      <div className="preview-banner">
        Preview — this is a draft and is not published{locale !== undefined && ` (${language})`}.
      </div>
      <h1>{post.title}</h1>
      {body === undefined || body === null ? (
        <p className="empty">Nothing written in {language} yet.</p>
      ) : (
        <RichText content={body as never} className="richtext" />
      )}
    </article>
  )
}
