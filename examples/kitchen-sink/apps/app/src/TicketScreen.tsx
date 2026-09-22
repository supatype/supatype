import React, { useState } from "react"
import { useFunction, useQuery } from "@supatype/react"
import { supatype } from "./client.js"
import type { Database } from "../../../supatype/generated/database"

type Ticket = Database["public"]["Tables"]["ticket"]["Row"]

/**
 * My ticket — and only mine.
 *
 * There is no `.eq("auth_user_id", user.id)` here on purpose. `Ticket`'s read rule is
 * `OwnerFrom<"authUser">`, so this unfiltered select returns exactly one row for its owner and
 * nothing for anyone else. The filter is not a convenience the client remembered; it is enforced
 * where a crafted request cannot get around it.
 */
export function TicketScreen({ userId }: { userId: string }): React.ReactElement {
  const { data, error, loading, refetch } = useQuery<Database, "ticket", Ticket>("ticket")

  // Issuing is server work: the reference is unique and the price is not the buyer's to choose, so
  // the row is written by a function holding the service role rather than by this client.
  const issue = useFunction<{ reference?: string; error?: string }>("issue-ticket")

  async function claim(): Promise<void> {
    await issue.invoke({})
    await refetch()
  }

  if (loading) return <p className="ks-muted">Looking up your ticket…</p>
  if (error) return <p className="ks-error">{error.message}</p>

  const ticket = data?.[0]
  if (!ticket) {
    return (
      <section>
        <p className="ks-muted">
          No ticket for this account yet. Claiming one calls an edge function, because this client
          cannot write the row: <code>reference</code> is unique and the price is not the buyer's
          to choose, so the function gates on your token and then writes with the service role.
        </p>
        <button className="ks-ghost" disabled={issue.loading} onClick={() => void claim()}>
          {issue.loading ? "Claiming…" : "Claim a ticket"}
        </button>
        {issue.error !== null && <p className="ks-error">{issue.error.message}</p>}
        <p className="ks-muted">
          Signed in as <code>{userId}</code>. The same query as somebody else returns an empty list
          rather than a 403, because the row is not theirs to see.
        </p>
      </section>
    )
  }

  return (
    <article className="ks-card">
      <h3>{ticket.reference}</h3>
      <dl className="ks-facts">
        <dt>Price</dt>
        <dd>{JSON.stringify(ticket.price)}</dd>
        <dt>VAT rate</dt>
        <dd>{ticket.vatRate}</dd>
        <dt>PDF</dt>
        <dd>{ticket.pdf ? ticket.pdf.path : "not issued yet"}</dd>
      </dl>
      <TicketPdf pdf={ticket.pdf} />
    </article>
  )
}

/**
 * Reaching a private object, which a URL alone cannot do.
 *
 * `ticket-files` is `BucketPrivate` with `read: BucketOwner`, so there is no public URL to link:
 * pasting one gets a 403 for everybody, its owner included. A signed URL is the way in — minted for
 * this caller, valid for a minute, and useless to anyone it is forwarded to once it expires.
 */
function TicketPdf({ pdf }: { pdf: unknown }): React.ReactElement {
  const [link, setLink] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const path = (pdf as { path?: string } | null)?.path ?? null

  if (path === null) {
    return (
      <p className="ks-muted">
        No PDF issued yet. When there is one it lives in a private bucket whose rule is{" "}
        <code>BucketOwner</code>, so the object is no more reachable than the row naming it.
      </p>
    )
  }

  async function sign(): Promise<void> {
    setError(null)
    const { data, error: signError } = await supatype.storage
      .from("ticket-files")
      .createSignedUrl(path!, 60)
    if (signError) setError(signError.message)
    else setLink(data?.signedUrl ?? null)
  }

  return (
    <div>
      <button className="ks-ghost" onClick={() => void sign()}>Get a download link</button>
      {error !== null && <p className="ks-error">{error}</p>}
      {link !== null && (
        <p className="ks-muted">
          <a href={link}>Signed link</a> — good for 60 seconds, and minted for you rather than
          shared with the world.
        </p>
      )}
    </div>
  )
}
