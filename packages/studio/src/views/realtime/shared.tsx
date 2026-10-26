import React from "react"
import { Badge, CodeBlock } from "../../components/ui.js"
import { EmptyState } from "../../components/EmptyState.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"
import type { InspectorFailure } from "../../hooks/useInspectorResource.js"
import type { PlatformMode } from "../../hooks/usePlatformApi.js"
import type { RedactedColumns, Sides } from "./types.js"

/** A time the way the Inspector's tables show it: the local clock time, the full date on hover. */
export function When({ at }: { at: string | null }): React.ReactElement {
  if (at === null) return <span className="text-muted-foreground">never</span>
  const date = new Date(at)
  return <span title={date.toISOString()}>{date.toLocaleTimeString()}</span>
}

const SELF_HOST_REALTIME_OFF =
  "This project runs without realtime (database.external.realtime is false). Remove that setting and restart the stack to turn it on."

/**
 * What a tab shows when the control plane would not answer: realtime turned off for the project is
 * a state to explain, anything else an error to retry.
 *
 * Only self-host can turn realtime off. Every Cloud plan includes it, so on Cloud the same answer
 * would be a fault, shown as one rather than explained away as a plan limit.
 */
export function InspectorFailureView({
  failure,
  mode,
  onRetry,
}: {
  failure: InspectorFailure
  mode: PlatformMode
  onRetry: () => void
}): React.ReactElement {
  if (mode === "self-host" && (failure.code === "realtime_disabled" || failure.status === 501)) {
    return <EmptyState title="Realtime is off for this project" description={SELF_HOST_REALTIME_OFF} />
  }
  return <ErrorBanner message={failure.message} onRetry={onRetry} />
}

function valueText(value: unknown): string {
  return JSON.stringify(value) ?? "undefined"
}

/** One side of a change, with each redacted column shown as redacted rather than as its null. */
function SideLines({ label, record, redacted }: { label: string; record: Record<string, unknown>; redacted: readonly string[] }): React.ReactElement {
  const columns = Object.keys(record)
  return (
    <>
      {`${label}: {\n`}
      {columns.map((column, i) => (
        <React.Fragment key={column}>
          {`  ${JSON.stringify(column)}: `}
          {redacted.includes(column) ? <Badge variant="yellow">redacted</Badge> : valueText(record[column])}
          {i < columns.length - 1 ? ",\n" : "\n"}
        </React.Fragment>
      ))}
      {"}\n"}
    </>
  )
}

/** A change's payload, old and new, as the viewer may see it. */
export function PayloadBlock({ sides, redacted }: { sides: Sides; redacted: RedactedColumns | undefined }): React.ReactElement {
  return (
    <CodeBlock className="text-xs p-3">
      {sides.old !== null && <SideLines label="old" record={sides.old} redacted={redacted?.old ?? []} />}
      {sides.new !== null && <SideLines label="new" record={sides.new} redacted={redacted?.new ?? []} />}
    </CodeBlock>
  )
}
