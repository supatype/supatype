/**
 * The project's database connection strings, from what the server says about reaching it.
 *
 * Settings and the Connect panel both render this, so there is one source for the string. It used
 * to be built from the API URL in two places, which named the gateway's port, the `postgres` login
 * and the `postgres` database, and offered a PgBouncer string for a deployment with no PgBouncer.
 * Now the direct string is the one the deployment declared, the pooler string appears only when a
 * pooler exists, and a database that is not published to the host says so instead.
 */

import React from "react"
import { Badge, Button, CodeBlock } from "../ui.js"
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard.js"
import { connectionString, useDatabaseConnection, type DbEndpoint } from "../../hooks/useDatabaseConnection.js"

export interface ConnectionStringPanelProps {
  /** The password to put in the strings, once the person has revealed it. A placeholder otherwise. */
  password?: string | null
  /** Also show the psql command for the direct string, as the Connect panel does. */
  withPsql?: boolean
}

function CopyableString({ label, value }: { label: string; value: string }): React.ReactElement {
  const { copied, copy } = useCopyToClipboard()
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[0.8rem] text-muted-foreground">{label}</span>
        <Button size="xs" onClick={() => copy(value)} aria-label={`Copy ${label.toLowerCase()}`}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <CodeBlock className="text-xs whitespace-pre-wrap break-all">{value}</CodeBlock>
    </div>
  )
}

function Unpublished({ reason }: { reason: string }): React.ReactElement {
  return (
    <div className="space-y-1">
      <Badge variant="yellow">Not published</Badge>
      <p className="text-xs text-muted-foreground">{reason}</p>
    </div>
  )
}

interface EndpointsProps extends ConnectionStringPanelProps {
  direct: DbEndpoint
  pooler: DbEndpoint | null
}

function Endpoints({ direct, pooler, password, withPsql }: EndpointsProps): React.ReactElement {
  const secret = password ?? undefined
  const directString = connectionString(direct, secret)
  return (
    <div className="space-y-3">
      <CopyableString label="Connection string" value={directString} />
      {pooler ? <CopyableString label="Pooler connection string" value={connectionString(pooler, secret)} /> : null}
      {withPsql ? <CopyableString label="Connect with psql" value={`psql '${directString}'`} /> : null}
    </div>
  )
}

export function ConnectionStringPanel({ password = null, withPsql = false }: ConnectionStringPanelProps): React.ReactElement {
  const { data, loading, error } = useDatabaseConnection()
  if (loading) return <p className="text-xs text-muted-foreground">Loading connection details...</p>
  if (error !== null) return <p className="text-xs text-red-400">{error}</p>
  if (!data?.direct) {
    return <Unpublished reason={data?.unavailable ?? "This deployment has not said where its database is reachable from."} />
  }
  return <Endpoints direct={data.direct} pooler={data.pooler} password={password} withPsql={withPsql} />
}
