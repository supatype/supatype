import React, { useState } from "react"
import { useFunction, useQuery } from "@supatype/react"
import { supatype } from "./client.js"
import type { Database } from "../../../supatype/generated/database"
import { Badge, Button, EmptyState, Note, PageHeader, ProvesNote, Row, Skeleton, Stack } from "./components/ui.js"

type Ticket = Database["public"]["Tables"]["ticket"]["Row"]

/**
 * My ticket, and only mine.
 *
 * There is no `.eq("authUser_id", user.id)` here on purpose. `Ticket`'s read rule is
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

  const note = (
    <ProvesNote>
      <p>
        The query is unfiltered. <code>OwnerFrom&lt;&quot;authUser&quot;&gt;</code> returns one row
        to its owner and an empty list to everyone else, so somebody else running exactly this
        query gets nothing rather than a 403.
      </p>
      <p>
        Claiming calls an edge function. This client cannot write the row itself:{" "}
        <code>reference</code> is unique and the price is not the buyer's to choose, so the
        function gates on your token and then writes with the service role.
      </p>
      <p>
        The PDF lives in a private bucket (<code>read: BucketOwner</code>), which a public URL
        cannot reach at all. A signed URL is minted for you, valid for a minute, and useless to
        anyone it is forwarded to once it expires.
      </p>
    </ProvesNote>
  )

  if (loading) {
    return (
      <>
        <PageHeader title="My ticket" />
        {note}
        <Skeleton rows={1} height={180} />
      </>
    )
  }
  if (error) {
    return (
      <>
        <PageHeader title="My ticket" />
        {note}
        <Note tone="error">{error.message}</Note>
      </>
    )
  }

  const ticket = data?.[0]

  if (!ticket) {
    return (
      <>
        <PageHeader title="My ticket" />
        {note}
        <EmptyState
          title="No ticket on this account"
          action={
            <Button variant="primary" disabled={issue.loading} onClick={() => void claim()}>
              {issue.loading ? "Claiming…" : "Claim a ticket"}
            </Button>
          }
        >
          Claiming runs the <code>issue-ticket</code> function, which checks your token and then
          writes the row with the service role.
        </EmptyState>
        {issue.error !== null && (
          <div style={{ marginTop: 12 }}>
            <Note tone="error">{issue.error.message}</Note>
          </div>
        )}
      </>
    )
  }

  return (
    <>
      <PageHeader title="My ticket" subtitle="Show this at the door." />
      {note}

      <div className="ks-ticket">
        <div className="ks-ticket__body">
          <Row gap={8} wrap>
            <Badge tone="accent">Admits one</Badge>
            <Badge>Full conference</Badge>
          </Row>

          <dl className="ks-facts">
            <dt>Reference</dt>
            <dd className="ks-mono">{ticket.reference}</dd>
            <dt>Price</dt>
            <dd>{formatMoney(ticket.price)}</dd>
            <dt>VAT</dt>
            <dd>{ticket.vatRate != null ? `${ticket.vatRate}%` : "—"}</dd>
            <dt>Holder</dt>
            <dd className="ks-mono ks-truncate" title={userId}>{userId.slice(0, 8)}…</dd>
          </dl>

          <div style={{ marginTop: 18 }}>
            <TicketPdf pdf={ticket.pdf} />
          </div>
        </div>

        <div className="ks-ticket__stub">
          <div className="ks-ticket__code" aria-hidden="true" />
          <div className="ks-ticket__ref">{ticket.reference}</div>
        </div>
      </div>
    </>
  )
}

/**
 * Reaching a private object, which a URL alone cannot do.
 *
 * `ticket-files` is `BucketPrivate` with `read: BucketOwner`, so there is no public URL to link:
 * pasting one gets a 403 for everybody, its owner included.
 */
function TicketPdf({ pdf }: { pdf: unknown }): React.ReactElement {
  const [link, setLink] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const path = (pdf as { path?: string } | null)?.path ?? null

  if (path === null) {
    return (
      <p className="ks-faint ks-small" style={{ margin: 0 }}>
        No PDF issued yet. When there is one it lives in a private bucket, so the object is no more
        reachable than the row naming it.
      </p>
    )
  }

  async function sign(): Promise<void> {
    setBusy(true)
    setError(null)
    const { data, error: signError } = await supatype.storage
      .from("ticket-files")
      .createSignedUrl(path!, 60)
    if (signError) setError(signError.message)
    else setLink(data?.signedUrl ?? null)
    setBusy(false)
  }

  return (
    <Stack gap={8}>
      <Row gap={10} wrap>
        <Button size="sm" disabled={busy} onClick={() => void sign()}>
          {busy ? "Signing…" : "Download PDF"}
        </Button>
        {link !== null && (
          <a className="ks-small" href={link}>
            Signed link, good for 60 seconds
          </a>
        )}
      </Row>
      {error !== null && <Note tone="error">{error}</Note>}
    </Stack>
  )
}

/** `Currency<"GBP">` crosses the wire as `{ currency, amount }`, with amount a string. */
function formatMoney(value: unknown): string {
  const money = value as { currency?: string; amount?: string | number } | null
  if (money == null || money.amount == null) return "—"
  const amount = Number(money.amount)
  if (!Number.isFinite(amount)) return String(money.amount)
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: money.currency ?? "GBP",
    }).format(amount / 100)
  } catch {
    return `${money.currency ?? ""} ${amount}`.trim()
  }
}
