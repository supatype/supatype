import React, { type ReactNode } from "react"
import { Box } from "ink"
import { theme } from "../theme.js"

/** A prompt never shrinks to fit: squeezed, its lines are drawn over one another. */
export function PromptPanel({ children }: { children: ReactNode }): React.ReactElement {
  return (
    <Box
      marginTop={1}
      borderStyle="round"
      borderColor={theme.brand}
      paddingX={1}
      flexDirection="column"
      flexShrink={0}
    >
      {children}
    </Box>
  )
}
