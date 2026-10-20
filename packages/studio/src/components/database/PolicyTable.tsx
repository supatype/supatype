import React from "react"
import { Badge, Button, Card, ConfirmButton, Dialog, Td, Th } from "../ui.js"
import { EmptyState } from "../EmptyState.js"
import { DROP_LOOK, DropPolicyButton } from "./DropPolicyButton.js"
import { cellText } from "../../views/metadata-row.js"
import type { PolicyCatalogue } from "../../hooks/usePolicyCatalogue.js"

/**
 * One table's row security and its policies, as the Authentication and Storage policy views show
 * them. Both views drew this table by hand, each slightly differently, so only one of them had the
 * "Applies to" column and neither stopped a long expression from widening the page.
 */

type Row = Record<string, unknown>

/** A table as the catalogue describes it: its heading, whether row security is on, and its policies. */
export interface PolicyTableData {
  /** How the heading names the table, such as `storage.objects`. */
  label: string
  rlsEnabled: boolean
  policies: Row[]
}

/** What a user who may write can do to the table; null for one who may only read. */
export interface PolicyTableActions {
  toggleRls: (enable: boolean) => void
  drop: (policyName: string) => void
  /**
   * Where a drop acts at once, so Drop asks first and names the policy it drops. Null when a drop
   * only drafts the statement for review: running the draft is what asks.
   */
  dropsAt: { schema: string; table: string } | null
}

/** Who a policy lets through, read from its expression, in a word or two. */
export function describeAppliesTo(row: Row): string {
  const withCheck = cellText(row, "with_check")
  const expr = (withCheck || cellText(row, "qual")).trim()
  const low = expr.toLowerCase()
  if (expr === "" || low === "true") return "Public"
  if (low === "false") return "No one"
  if (low.includes("auth.uid() is not null")) return "Logged in"
  return describeNamedAccess(expr) ?? (cellText(row, "cmd").toUpperCase() === "INSERT" && withCheck ? "Custom (insert check)" : "Custom")
}

/** An owner column or a role the expression compares against, when it names one. */
function describeNamedAccess(expr: string): string | null {
  const owner = expr.match(/auth\.uid\(\)\s*=\s*([a-zA-Z_][a-zA-Z0-9_]*)/)
  if (owner) return `Owner (${owner[1]})`
  const role = expr.match(/auth\.role\(\)\s*=\s*'([^']+)'/)
  if (role) return `Role: ${role[1]}`
  const anyRole = expr.match(/auth\.role\(\)\s*=\s*ANY\(ARRAY\[(.+)\]\)/i)
  const roles = Array.from((anyRole?.[1] ?? "").matchAll(/'([^']+)'/g)).flatMap((m) => (m[1] === undefined ? [] : [m[1]]))
  return roles.length > 0 ? `Roles: ${roles.join(", ")}` : null
}

export function PolicyTableCard({ table, actions }: { table: PolicyTableData; actions: PolicyTableActions | null }): React.ReactElement {
  return (
    <Card>
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-border bg-muted/40">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-sm font-medium text-foreground truncate">{table.label}</span>
          <Badge variant={table.rlsEnabled ? "green" : "red"}>{table.rlsEnabled ? "RLS on" : "RLS off"}</Badge>
        </div>
        {actions ? <RlsToggle table={table.label} enabled={table.rlsEnabled} toggle={actions.toggleRls} /> : null}
      </div>
      <table className="w-full text-sm table-fixed">
        <colgroup>
          <col className="w-[18%]" />
          <col className="w-[11%]" />
          <col className="w-[13%]" />
          <col />
          <col className="w-[14%]" />
          <col className="w-[8%]" />
        </colgroup>
        <thead>
          <tr className="border-b border-border">
            <Th>Policy</Th>
            <Th>Command</Th>
            <Th>Permissive</Th>
            <Th>Expression</Th>
            <Th>Applies to</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {table.policies.map((p, index) => <PolicyRow key={`${cellText(p, "policyname")}-${index}`} policy={p} actions={actions} />)}
        </tbody>
      </table>
    </Card>
  )
}

function PolicyRow({ policy, actions }: { policy: Row; actions: PolicyTableActions | null }): React.ReactElement {
  const name = cellText(policy, "policyname")
  const withCheck = cellText(policy, "with_check")
  const permissive = cellText(policy, "permissive")
  return (
    <tr className="border-b border-border last:border-0 align-top">
      <Td className="font-mono text-xs text-foreground truncate" title={name}>{name || "-"}</Td>
      <Td><Badge variant="blue">{cellText(policy, "cmd") || "-"}</Badge></Td>
      <Td><Badge variant={permissive === "PERMISSIVE" ? "green" : "yellow"}>{permissive || "-"}</Badge></Td>
      <Td>
        <div className="flex items-start gap-2 min-w-0">
          <Badge variant="blue">{withCheck ? "WITH CHECK" : "USING"}</Badge>
          {/* Wrapped at a space where there is one and inside a word where there is not: a cell that
              cannot break a long expression pushes the whole page sideways. */}
          <code className="min-w-0 text-xs text-foreground whitespace-pre-wrap break-words">{withCheck || cellText(policy, "qual") || "(none)"}</code>
        </div>
      </Td>
      <Td className="text-xs text-muted-foreground">{describeAppliesTo(policy)}</Td>
      <Td className="text-right">
        {actions ? <DropControl name={name} actions={actions} /> : null}
      </Td>
    </tr>
  )
}

/** Drop on one policy: asks first where it drops at once, and opens the draft where it only drafts. */
function DropControl({ name, actions }: { name: string; actions: PolicyTableActions }): React.ReactElement {
  const drop = (): void => { actions.drop(name) }
  if (actions.dropsAt) return <DropPolicyButton policy={{ ...actions.dropsAt, name }} drop={drop} />
  return <Button {...DROP_LOOK} onClick={drop}>Drop</Button>
}

/**
 * Switches a table's row security. Turning it on only narrows who sees what, so it happens on the
 * click; turning it off opens every row to every role the table is granted to, so it asks first.
 */
function RlsToggle({ table, enabled, toggle }: { table: string; enabled: boolean; toggle: (enable: boolean) => void }): React.ReactElement {
  if (!enabled) {
    return <Button size="xs" variant="primary" className="shrink-0 whitespace-nowrap" onClick={() => { toggle(true) }}>Enable RLS</Button>
  }
  const ask = {
    title: `Disable RLS on ${table}?`,
    detail: <p>Without row level security its policies stop applying, and every role granted access to this table can read and change every row.</p>,
    answer: "Disable RLS",
  }
  return <ConfirmButton size="xs" variant="destructive" className="shrink-0 whitespace-nowrap" ask={ask} act={() => { toggle(false) }}>Disable RLS</ConfirmButton>
}

/** How a view lists its tables: the heading each gets, and what a writer may do to each. */
export interface PolicyListOptions {
  label: (table: string) => string
  actionsFor: ((table: string) => PolicyTableActions) | null
  empty: { title: string; description: string }
}

/** Every table in the catalogue as a {@link PolicyTableCard}, with its loading and empty states. */
export function PolicyTableList({ catalogue, options }: { catalogue: PolicyCatalogue; options: PolicyListOptions }): React.ReactElement {
  if (catalogue.loading) {
    return <div className="space-y-2">{[1, 2, 3].map((i) => <div key={i} className="h-10 rounded-md bg-muted animate-pulse" />)}</div>
  }
  if (catalogue.grouped.size === 0) return <EmptyState title={options.empty.title} description={options.empty.description} />
  return (
    <div className="space-y-4">
      {[...catalogue.grouped.entries()].map(([name, policies]) => (
        <PolicyTableCard
          key={name}
          table={{ label: options.label(name), rlsEnabled: catalogue.rlsMap.get(name) ?? false, policies }}
          actions={options.actionsFor ? options.actionsFor(name) : null}
        />
      ))}
    </div>
  )
}

/** The warning before a policy is written by hand rather than declared in the schema. */
export function ManualPolicyWarning({ subject, onCancel, onContinue }: { subject: string; onCancel: () => void; onContinue: () => void }): React.ReactElement {
  return (
    <Dialog
      title="Manual policy warning"
      actions={<><Button onClick={onCancel}>Cancel</Button><Button variant="primary" onClick={onContinue}>I understand, continue</Button></>}
    >
      <p>It is strongly recommended to define {subject} in your schema so migrations remain reproducible and reviewable.</p>
      <p>If you create policies manually in Studio, you do so at your own risk. Manual policies may interact with generated policies in unexpected ways.</p>
    </Dialog>
  )
}
