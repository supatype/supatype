import React from "react"
import type { FieldConfig, ModelConfig } from "../config.js"
import { describeConstraint } from "../lib/evaluate-constraint.js"
import { Badge, Card, Td, Th } from "../components/ui.js"

/**
 * Everything constraining or indexing one model, in the terms the author wrote them.
 *
 * These rules are otherwise invisible until they fire. A bound shows up as a rejected save, an index
 * shows up as a query that is unexpectedly fast or slow, and neither is discoverable from the record
 * editor. Reading them off the schema file works only for whoever has it open.
 *
 * Rendered from the admin config the engine produced, so this is what the database is actually
 * enforcing rather than what the checked-in schema says. On a project mid-push those differ, and the
 * one worth showing is the one in force.
 */
export function ModelRules({ model }: { model: ModelConfig }): React.ReactElement {
  const bounded = model.fields.filter(hasBounds)
  const constraints = model.constraints ?? []
  const indexes = model.indexes ?? []

  return (
    <div className="max-w-4xl space-y-5">
      <div>
        <h1 className="text-lg font-semibold">{model.label} rules</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          What the database enforces on{" "}
          <code className="font-mono text-xs">{model.tableName}</code>, and how it is indexed.
        </p>
      </div>

      <Section
        title="Field bounds"
        count={bounded.length}
        empty="No field on this model declares a bound."
        columns={["Field", "Rule"]}
      >
        {bounded.map((field) => (
          <tr key={field.name} className="hover:bg-muted/20 transition-colors">
            <Td>
              <code className="font-mono text-xs">{field.label}</code>
              {field.localized && (
                <Badge variant="blue" className="ml-2">
                  per locale
                </Badge>
              )}
            </Td>
            <Td className="text-muted-foreground">{describeBounds(field)}</Td>
          </tr>
        ))}
      </Section>

      <Section
        title="Constraints"
        count={constraints.length}
        empty="This model declares no model-level constraints."
        columns={["Rule", "Columns"]}
      >
        {constraints.map((constraint) => (
          <tr key={constraint.name} className="hover:bg-muted/20 transition-colors">
            {/* The same renderer the editor uses for a failure, so the wording an author sees
                here is the wording they will see when it refuses a save. */}
            <Td>{describeConstraint(constraint.rule, model.fields, {})}</Td>
            <Td className="text-muted-foreground">
              <code className="font-mono text-xs">{constraint.columns.join(", ")}</code>
            </Td>
          </tr>
        ))}
      </Section>

      <Section
        title="Indexes"
        count={indexes.length}
        empty="This model declares no indexes."
        note="Indexes the engine creates on its own, for a relation or a blocks field, are not listed: they follow from other declarations rather than being chosen."
        columns={["Name", "Columns", "Type"]}
      >
        {indexes.map((index) => (
          <tr key={index.name} className="hover:bg-muted/20 transition-colors">
            <Td>
              <code className="font-mono text-xs">{index.name}</code>
            </Td>
            <Td className="text-muted-foreground">
              <code className="font-mono text-xs">{index.fields.join(", ")}</code>
            </Td>
            <Td>
              {index.using.toUpperCase()}
              {index.unique && (
                <Badge variant="green" className="ml-2">
                  unique
                </Badge>
              )}
            </Td>
          </tr>
        ))}
      </Section>
    </div>
  )
}

function Section({
  title,
  count,
  empty,
  note,
  columns,
  children,
}: {
  title: string
  count: number
  empty: string
  note?: string
  columns: string[]
  children: React.ReactNode
}): React.ReactElement {
  return (
    <Card>
      <div className="px-4 py-3 border-b border-border">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          {count} {count === 1 ? "rule" : "rules"}
        </p>
      </div>

      {/* An empty section is kept rather than hidden: "this model has no constraints" is a fact
          worth showing, and a page that silently omits a heading looks like it failed to load. */}
      {count === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                {columns.map((column) => (
                  <Th key={column}>{column}</Th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">{children}</tbody>
          </table>
        </div>
      )}

      {note !== undefined && count > 0 && (
        <p className="px-4 py-2.5 text-xs text-muted-foreground border-t border-border">{note}</p>
      )}
    </Card>
  )
}

function hasBounds(field: FieldConfig): boolean {
  const rules = field.validation
  return rules !== undefined && Object.keys(rules).length > 0
}

/** A field's bounds in words, in the same units the database counts. */
function describeBounds(field: FieldConfig): string {
  const rules = field.validation ?? {}
  const parts: string[] = []

  const unit = field.widget === "richtext" ? "characters of text" : "characters"
  if (rules.maxLength !== undefined) parts.push(`at most ${rules.maxLength} ${unit}`)
  if (rules.minLength !== undefined) parts.push(`at least ${rules.minLength} ${unit}`)
  if (rules.maxItems !== undefined) parts.push(`at most ${rules.maxItems} items`)
  if (rules.minItems !== undefined) parts.push(`at least ${rules.minItems} items`)
  if (rules.min !== undefined) parts.push(`${rules.min} or more`)
  if (rules.max !== undefined) parts.push(`${rules.max} or less`)

  return parts.join(", ")
}
