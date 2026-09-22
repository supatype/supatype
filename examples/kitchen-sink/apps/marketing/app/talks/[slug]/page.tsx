import React from "react"
import type { Metadata } from "next"
import { headers } from "next/headers"
import { RichText } from "@supatype/react"
import { createClient } from "@/lib/supatype-server"
import { localized, publicImageUrl } from "@/lib/localized"
import type { Database } from "../../../../../supatype/generated/database"

type Talk = Database["public"]["Tables"]["talk"]["Row"]
type Speaker = Database["public"]["Tables"]["speaker"]["Row"]

async function talkBySlug(slug: string): Promise<Talk | null> {
  const supatype = await createClient()
  const { data } = await supatype.from("talk").select().eq("slug", slug).limit(1)
  return (data as Talk[] | null)?.[0] ?? null
}

/**
 * The tags a crawler reads, built on the server from the row.
 *
 * This is the half a client-rendered app cannot do: a crawler that does not run JavaScript sees
 * whatever the first response contained, so metadata assembled in the browser is metadata nobody
 * indexes. The og:image is a *derivative* — the headshot resized on read rather than a second
 * upload kept in step by hand.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const talk = await talkBySlug(slug)
  if (talk === null) return { title: "Talk not found" }

  const supatype = await createClient()
  const { data: speakers } = await supatype
    .from("speaker")
    .select()
    .eq("id", talk.speaker_id ?? "")
    .limit(1)
  const speaker = (speakers as Speaker[] | null)?.[0]

  const image = publicImageUrl(speaker?.headshot, { width: 1200, height: 630, resize: "cover", format: "webp" })

  return {
    title: talk.title,
    description: speaker ? `${talk.title} — ${speaker.name}` : talk.title,
    openGraph: {
      title: talk.title,
      type: "article",
      ...(image !== null && { images: [{ url: image, width: 1200, height: 630 }] }),
    },
  }
}

export default async function TalkPage({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<React.ReactElement> {
  const { slug } = await params
  const talk = await talkBySlug(slug)

  if (talk === null) {
    return (
      <section>
        <h1>Not found</h1>
        <p className="ks-muted">
          Either there is no talk with this slug, or it is not published. Those are the same answer
          here on purpose: <code>Lte&lt;&quot;published_at&quot;, Now&gt;</code> makes an
          unpublished row unreadable, so the page cannot tell a stranger that a draft exists.
        </p>
      </section>
    )
  }

  // The locale middleware chose this, once, on the edge. Reading it here rather than re-deciding
  // keeps one request on one language.
  const locale = (await headers()).get("x-locale") ?? "en"
  const abstract = localized(talk.abstract, locale)

  return (
    <article>
      <h1>{talk.title}</h1>
      <p className="ks-muted">
        {new Date(talk.starts_at).toLocaleString("en-GB", {
          weekday: "long",
          hour: "2-digit",
          minute: "2-digit",
        })}
      </p>
      {abstract === null ? (
        <p className="ks-muted">
          Nothing written in {locale} yet — and nothing in another language shown in its place. A
          localized column holds every locale at once, so an untranslated one is <em>absent</em>
          rather than silently swapped.
        </p>
      ) : (
        <RichText content={abstract as never} className="ks-prose" />
      )}
    </article>
  )
}
