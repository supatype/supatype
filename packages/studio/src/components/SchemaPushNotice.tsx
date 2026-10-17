import React from "react"
import { useNavigate } from "react-router-dom"
import { usePendingSchemaPush } from "../hooks/usePendingSchemaPush.js"
import { migrationHistoryHref } from "../lib/migration-outcome.js"
import { RefusalHints, RefusalOperations, withoutForceAdvice } from "./PushRefusalDetails.js"
import { Badge, Button, Card } from "./ui.js"

/**
 * Says, on every screen, that the newest schema push was refused or failed.
 *
 * Mounted once for the whole app on purpose: it is a claim about the project's schema, not about
 * the view it sits above, and it is true of every screen while it shows. Studio and the generated
 * code describe the schema the database has, which is the last push that applied; this is where a
 * person learns that the schema they declared since is not it, and how to apply it. It goes away
 * by itself once a push applies.
 */
export function SchemaPushNotice(): React.ReactElement | null {
  const pending = usePendingSchemaPush()
  const navigate = useNavigate()
  if (pending === null) return null
  const title = pending.status === "refused" ? "Schema push refused" : "Schema push failed"
  return (
    <Card role="status" className="mb-4 px-4 py-3 space-y-2 text-xs">
      <div className="flex items-center gap-2">
        <Badge variant="red">{title}</Badge>
        <span className="text-muted-foreground">
          Nothing was applied. The database is still on the schema from the last push that applied,
          and Studio and the generated code describe that schema.
        </span>
        <Button size="xs" className="ml-auto shrink-0" onClick={() => navigate(migrationHistoryHref(pending.id))}>
          View in Migration History
        </Button>
      </div>
      {pending.error !== null && <p className="font-mono">{withoutForceAdvice(pending.error)}</p>}
      <RefusalOperations operations={pending.operations} />
      <RefusalHints hints={pending.hints} />
      <p className="text-muted-foreground">This notice is about the project&apos;s schema and clears once a push applies.</p>
    </Card>
  )
}
