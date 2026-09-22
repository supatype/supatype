import React from "react"
import { createClient } from "@/lib/supatype-server"
import { Blocks } from "./blocks"
import type { Database } from "../../../supatype/generated/database"

type Page = Database["public"]["Tables"]["page"]["Row"]

/**
 * The home page, assembled from blocks an editor arranged.
 *
 * No `.eq("published_at", …)`: `Page`'s read rule is `Lte<"published_at", Now>`, so an unpublished
 * page is unreadable rather than merely unselected — and this request carries the reader's session,
 * so an editor with a draft sees their draft and a stranger sees nothing.
 */
export default async function HomePage(): Promise<React.ReactElement> {
  const supatype = await createClient()
  const { data, error } = await supatype
    .from("page")
    .select()
    .eq("slug", "home")
    .limit(1)

  if (error !== null) return <p className="ks-error">Error: {error.message}</p>

  const page = (data as Page[] | null)?.[0]
  if (!page) {
    return (
      <section>
        <h1>Nothing published yet</h1>
        <p className="ks-muted">
          Create a page with the slug <code>home</code> in Studio and publish it. It appears here at
          the moment <code>published_at</code> passes — no rebuild, no revalidation hook.
        </p>
      </section>
    )
  }

  return (
    <article>
      <h1>{page.title}</h1>
      {page.summary !== null && <p className="ks-lede">{page.summary}</p>}
      <Blocks blocks={page.body} />
    </article>
  )
}
