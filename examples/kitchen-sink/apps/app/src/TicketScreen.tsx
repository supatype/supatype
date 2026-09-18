import React from "react"
import { useQuery } from "@supatype/react"
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
  const { data, error, loading } = useQuery<Database, "ticket", Ticket>("ticket")

  if (loading) return <p className="ks-muted">Looking up your ticket…</p>
  if (error) return <p className="ks-error">{error.message}</p>

  const ticket = data?.[0]
  if (!ticket) {
    return (
      <p className="ks-muted">
        No ticket for this account. Seed one against <code>{userId}</code> and it appears here —
        and only here: the same query signed in as somebody else returns an empty list rather than
        a 403, because the row is not theirs to see.
      </p>
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
      <p className="ks-muted">
        The PDF lives in a private bucket whose own rule is <code>BucketOwner</code>, so the storage
        object is no more reachable than the row that names it.
      </p>
    </article>
  )
}
