"use client"

import React from "react"
import { useLivePreview } from "@supatype/react"
import { Blocks } from "../../blocks"
import type { Database } from "../../../../../supatype/generated/database"

type Page = Database["public"]["Tables"]["page"]["Row"]

/**
 * The saved draft, replaced live while somebody types in Studio.
 *
 * `initialData` is what the server read. When this page is open in Studio's preview pane with Live
 * Preview on, the editor posts its form state here on every keystroke and `data` becomes that
 * instead — nothing has been saved, and there is nothing in the database to read.
 *
 * `model` matters: without it, any model's preview stream would land here, so editing a Talk would
 * repaint this page with a Talk's fields.
 */
export function LivePage({ initial }: { initial: Page }): React.ReactElement {
  const { data, isPreview } = useLivePreview<Page>({ initialData: initial, model: "page" })

  return (
    <article>
      <div className={isPreview ? "ks-banner ks-banner--live" : "ks-banner"}>
        {isPreview
          ? "Live — these are unsaved keystrokes from the Studio tab, not the database."
          : "Draft — this is the saved draft, not what readers see."}
      </div>
      <h1>{typeof data.title === "string" ? data.title : "Untitled"}</h1>
      {data.summary !== null && <p className="ks-lede">{data.summary}</p>}
      <Blocks blocks={data.body} />
    </article>
  )
}
