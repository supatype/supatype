import React, { useState } from "react"
import { isStudioAdminSchema, useProjectProxy } from "../../hooks/useProjectProxy.js"
import { usePolicyWrites } from "../../hooks/usePolicyWrites.js"
import { PolicyCreatePanel, type PolicyTarget } from "../../components/database/PolicyCreatePanel.js"
import { ManualPolicyWarning, PolicyTableList, type PolicyTableActions } from "../../components/database/PolicyTable.js"
import { usePolicyCatalogue, type PolicyCatalogue } from "../../hooks/usePolicyCatalogue.js"
import { SqlDraftDialog, useSqlDraft } from "../../components/database/SqlDraftDialog.js"
import { useSqlEditorOffered } from "../../hooks/useSqlEditorOffered.js"
import { useSchemaPicker } from "../../hooks/useSchemaPicker.js"
import { Button, PageHeader } from "../../components/ui.js"
import { SchemaSelect } from "../../components/database/SchemaSelect.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"
import { qualifiedName, quoteIdent } from "../../lib/sql-identifier.js"

function policyTemplate(schema: string): string {
  return `CREATE POLICY my_policy ON ${quoteIdent(schema)}.my_table
  AS PERMISSIVE
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);`
}

/** Every table the view has seen in this schema, with or without a policy yet. */
function knownTables(catalogue: PolicyCatalogue): string[] {
  return [...new Set([...catalogue.rlsMap.keys(), ...catalogue.grouped.keys()])].filter((t) => t !== "").sort()
}

/**
 * The writes the view offers, on whichever route the schema takes. The SQL editor's login cannot
 * alter auth or storage tables, so those go through `/studio-admin` (SQ2); any other schema keeps
 * the SQL editor's route, and a drop or a new policy there is SQL the user reviews before it runs.
 */
function usePolicyEditing(schema: string, catalogue: PolicyCatalogue) {
  const proxy = useProjectProxy()
  const writes = usePolicyWrites(catalogue.refresh)
  const draft = useSqlDraft(schema, catalogue.refresh)
  const [createTarget, setCreateTarget] = useState<PolicyTarget | null>(null)
  const adminSchema = isStudioAdminSchema(schema) ? schema : null
  const actionsFor = (table: string): PolicyTableActions => ({
    toggleRls: (enable) => {
      if (adminSchema) void writes.toggleRls(adminSchema, table, enable)
      else void writes.run(() => proxy.sql(`ALTER TABLE ${qualifiedName(schema, table)} ${enable ? "ENABLE" : "DISABLE"} ROW LEVEL SECURITY;`, schema))
    },
    drop: (name) => {
      if (adminSchema) void writes.dropPolicy(adminSchema, table, name)
      else draft.open(`DROP POLICY ${quoteIdent(name)} ON ${qualifiedName(schema, table)};`)
    },
    dropsAt: adminSchema ? { schema: adminSchema, table } : null,
  })
  const create = (): void => {
    if (adminSchema) setCreateTarget({ schema: adminSchema, tables: knownTables(catalogue) })
    else draft.open(policyTemplate(schema))
  }
  return { writeError: writes.writeError, draft, createTarget, setCreateTarget, actionsFor, create }
}

export function PoliciesView(): React.ReactElement {
  // Writes are open to the SQL editor's roles only, on whichever route they take (RQ4, SQ2).
  const sqlWrites = useSqlEditorOffered()
  const picker = useSchemaPicker()
  const { schema } = picker
  const catalogue = usePolicyCatalogue(schema)
  const editing = usePolicyEditing(schema, catalogue)
  const [warningOpen, setWarningOpen] = useState(false)
  return (
    <div className="space-y-4">
      <PageHeader
        title="Policies"
        scope={<SchemaSelect picker={picker} />}
        action={sqlWrites ? <Button variant="primary" onClick={() => { setWarningOpen(true) }}>Create policy</Button> : null}
      />
      {catalogue.error && <ErrorBanner message={catalogue.error} />}
      {editing.writeError && <ErrorBanner message={editing.writeError} />}
      <PolicyTableList
        catalogue={catalogue}
        options={{
          label: (table) => table,
          actionsFor: sqlWrites ? editing.actionsFor : null,
          empty: { title: "No policies", description: `No RLS policies found in schema "${schema}".` },
        }}
      />
      <SqlDraftDialog draft={editing.draft} />
      <PolicyCreatePanel target={editing.createTarget} onClose={(created) => { editing.setCreateTarget(null); if (created) catalogue.refresh() }} />
      {warningOpen ? <ManualPolicyWarning subject="row-level security policies" onCancel={() => { setWarningOpen(false) }} onContinue={() => { setWarningOpen(false); editing.create() }} /> : null}
    </div>
  )
}
