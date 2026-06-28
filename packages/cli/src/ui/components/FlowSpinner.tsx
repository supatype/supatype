import React from "react"
import { Box, Text } from "ink"
import Spinner from "ink-spinner"
import { theme } from "../theme.js"

export function FlowSpinner({ message }: { message: string }): React.ReactElement {
  return (
    <Box marginBottom={1}>
      <Text color={theme.brand}>
        <Spinner type="dots" />
        {` ${message}`}
      </Text>
    </Box>
  )
}
