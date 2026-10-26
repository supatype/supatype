import React from "react"
import { ConfirmButton } from "../ui.js"

/** The policy a Drop button names: where it is, and what it is called. */
export interface PolicyRef {
  schema: string
  table: string
  name: string
}

/**
 * How Drop looks on every row of a policy table, so the two Policies views read the same. A Drop
 * that only drafts the statement (on a schema the admin routes do not cover) uses it on a plain
 * Button: running the draft is what asks.
 */
export const DROP_LOOK = { size: "xs", variant: "ghost", className: "text-destructive hover:text-destructive" } as const

/**
 * Drop on one row of a Policies view: the click asks first and the policy goes on the destructive
 * answer. A dropped policy is gone, and whatever it allowed is refused from then on.
 */
export function DropPolicyButton({ policy, drop }: { policy: PolicyRef; drop: () => void }): React.ReactElement {
  const ask = {
    title: `Drop policy ${policy.name} on ${policy.schema}.${policy.table}?`,
    detail: <p>The policy is deleted. Whatever it allowed is refused from now on, unless another policy allows it.</p>,
    answer: "Drop policy",
  }
  return <ConfirmButton {...DROP_LOOK} ask={ask} act={drop}>Drop</ConfirmButton>
}
