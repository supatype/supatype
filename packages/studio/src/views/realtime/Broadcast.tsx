import React, { useState } from "react"
import { Button, Card, Input, Textarea } from "../../components/ui.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"
import { parseJsonObject } from "../../lib/json.js"
import { readInspectorJson, type InspectorFailure } from "../../hooks/useInspectorResource.js"
import { isBroadcastSent } from "../../lib/realtime-guards.js"
import type { InspectorTabProps } from "./InspectorTab.js"
import { InspectorFailureView } from "./shared.js"
import type { BroadcastRequest } from "./types.js"

/**
 * The broadcast tester: send one message to a channel, as if a client had, and see how many
 * subscribers it reached. Every send is audited (without its payload) and limited to ten a minute.
 */

type Outcome =
  | { kind: "idle" }
  | { kind: "sent"; recipients: number }
  | { kind: "invalid"; message: string }
  | { kind: "limited"; retryAfter: string | null }
  | { kind: "failed"; failure: InspectorFailure }

/** The form's payload as an object, or why it is not one. */
export function parsePayload(text: string): Record<string, unknown> | string {
  const parsed = parseJsonObject(text)
  if (parsed.ok) return parsed.value
  return parsed.error === "not-json" ? "The payload is not valid JSON." : "The payload must be a JSON object."
}

async function send(api: InspectorTabProps["api"], request: BroadcastRequest): Promise<Outcome> {
  const res = await api.fetch("realtime/broadcast", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  })
  if (res.status === 429) return { kind: "limited", retryAfter: res.headers.get("Retry-After") }
  const answer = await readInspectorJson(res, isBroadcastSent)
  return "data" in answer ? { kind: "sent", recipients: answer.data.recipients } : { kind: "failed", failure: answer.failure }
}

function OutcomeLine({ outcome, api }: { outcome: Outcome; api: InspectorTabProps["api"] }): React.ReactElement | null {
  switch (outcome.kind) {
    case "idle":
      return null
    case "sent":
      return <p className="text-sm text-foreground">Sent to {outcome.recipients} {outcome.recipients === 1 ? "subscriber" : "subscribers"}.</p>
    case "invalid":
      return <ErrorBanner message={outcome.message} />
    case "limited":
      return <ErrorBanner message={`Too many test broadcasts. Try again in ${outcome.retryAfter === null ? "a minute" : `${outcome.retryAfter} seconds`}.`} />
    case "failed":
      return <InspectorFailureView failure={outcome.failure} mode={api.mode} onRetry={() => {}} />
  }
}

export function Broadcast({ api }: InspectorTabProps): React.ReactElement {
  const [channel, setChannel] = useState("")
  const [event, setEvent] = useState("")
  const [payload, setPayload] = useState("{}")
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" })

  const submit = async (): Promise<void> => {
    const parsed = parsePayload(payload)
    if (typeof parsed === "string") return setOutcome({ kind: "invalid", message: parsed })
    setBusy(true)
    try {
      setOutcome(await send(api, { channel: channel.trim(), event: event.trim(), payload: parsed }))
    } catch (err) {
      setOutcome({ kind: "failed", failure: { status: null, code: null, message: err instanceof Error ? err.message : "Network error" } })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="p-4 space-y-3 max-w-2xl">
      <div className="grid grid-cols-2 gap-3">
        <Input aria-label="Channel" placeholder="Channel, e.g. room:1" value={channel} onChange={(e) => setChannel(e.target.value)} />
        <Input aria-label="Event" placeholder="Event, e.g. ping" value={event} onChange={(e) => setEvent(e.target.value)} />
      </div>
      <Textarea aria-label="Payload" rows={8} value={payload} onChange={(e) => setPayload(e.target.value)} />
      <div className="flex items-center gap-3">
        <Button variant="primary" disabled={busy || channel.trim() === "" || event.trim() === ""} onClick={() => void submit()}>
          {busy ? "Sending…" : "Send"}
        </Button>
        <span className="text-xs text-muted-foreground">Recorded in the project's audit trail, without the payload.</span>
      </div>
      <OutcomeLine outcome={outcome} api={api} />
    </Card>
  )
}
