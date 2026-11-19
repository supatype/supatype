import React from "react"
import { Card, Table, Td, Th } from "../ui.js"

/** One line of a facts card: what it is, its value, and where the value is set when that matters. */
export interface Fact {
  label: string
  value: React.ReactNode
  /** Where the value is set. Giving it on any row adds the "Set by" column to the card. */
  source?: React.ReactNode
}

/** A titled, read-only list of facts, drawn as the auth settings pages draw theirs. */
export function FactsCard({ title, facts }: { title: string; facts: Fact[] }): React.ReactElement {
  const withSource = facts.some((fact) => fact.source !== undefined)
  return (
    <Card>
      <h3 className="text-sm font-medium text-foreground px-4 pt-4 pb-2">{title}</h3>
      <div className="overflow-x-auto">
        <Table>
          <thead>
            <tr className="border-b border-border bg-muted/40">
              <Th className="px-4 py-2.5">Setting</Th>
              <Th className="px-4 py-2.5">Value</Th>
              {withSource && <Th className="px-4 py-2.5">Set by</Th>}
            </tr>
          </thead>
          <tbody>
            {facts.map((fact) => (
              <tr key={fact.label} className="border-b border-border last:border-0">
                <Td className="px-4 py-3">{fact.label}</Td>
                <Td className="px-4 py-3">{fact.value}</Td>
                {withSource && <Td className="px-4 py-3">{fact.source}</Td>}
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </Card>
  )
}
