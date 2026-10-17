import React from "react"
import { CodeBlock } from "./ui.js"

/** The engine's own advice names its flag; Studio names the CLI command, listed with the hints. */
export function withoutForceAdvice(message: string): string {
  return message.replace(/\s*Use --force to proceed\.?/g, "").trim()
}

/** What a refused push would have dropped or rewritten, or the objects in its way, one per line. */
export function RefusalOperations({ operations }: { operations: string[] }): React.ReactElement | null {
  if (operations.length === 0) return null
  return (
    <ul className="space-y-0.5 font-mono text-[0.7rem]">
      {operations.map((operation) => (
        <li key={operation}>{operation}</li>
      ))}
    </ul>
  )
}

/** The commands that apply a refused push, or deal with what refused it. */
export function RefusalHints({ hints }: { hints: string[] }): React.ReactElement | null {
  if (hints.length === 0) return null
  return (
    <div className="space-y-1">
      <p className="text-muted-foreground">To apply it:</p>
      <CodeBlock className="p-2 text-[0.7rem]">{hints.join("\n")}</CodeBlock>
    </div>
  )
}
