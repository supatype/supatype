import React from "react"
import { Button, Td } from "../../components/ui.js"
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard.js"

/** One labelled value in a table, in code type, with a button that copies it. */
export function CopyRow({ label, value }: { label: string; value: string }): React.ReactElement {
  const { copied, copy } = useCopyToClipboard()
  return (
    <tr className="border-b border-border last:border-0">
      <Td className="px-4 py-3 whitespace-nowrap">{label}</Td>
      <Td className="px-4 py-3"><code className="font-mono text-xs text-foreground break-all">{value}</code></Td>
      <Td className="px-4 py-3 text-right">
        <Button size="xs" variant="ghost" aria-label={`Copy ${label}`} onClick={() => { copy(value) }}>{copied ? "Copied" : "Copy"}</Button>
      </Td>
    </tr>
  )
}
