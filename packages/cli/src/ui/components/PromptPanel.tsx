import React, { type ReactNode } from "react"
import { Box } from "ink"
import { theme } from "../theme.js"

export function PromptPanel({ children }: { children: ReactNode }): React.ReactElement {
  return (
    <Box
      marginTop={1}
      borderStyle="round"
      borderColor={theme.brand}
      paddingX={1}
      flexDirection="column"
    >
      {children}
    </Box>
  )
}
