import React from "react"
import { Box, Text } from "ink"
import { layoutLogoBlock, pickLogoLines } from "../../dev-logo.js"
import { theme } from "../theme.js"

function truncatePlain(text: string, width: number): string {
  if (text.length <= width) return text
  if (width <= 1) return text.slice(0, width)
  return `${text.slice(0, width - 1)}…`
}

export interface LogoWordmarkProps {
  maxWidth?: number
  /** Small caption under the figlet wordmark. */
  tagline?: string
}

/** Figlet slant wordmark — native Ink colours (no embedded ANSI). */
export function LogoWordmark({ maxWidth, tagline }: LogoWordmarkProps): React.ReactElement {
  const lines = layoutLogoBlock(pickLogoLines())

  return (
    <Box flexDirection="column" marginBottom={tagline ? 0 : 1}>
      {lines.map((line, index) => (
        <Text key={`logo-${index}`} bold color={theme.brand}>
          {maxWidth !== undefined ? truncatePlain(line, maxWidth) : line}
        </Text>
      ))}
      {tagline ? (
        <Text dimColor color={theme.brand}>
          {tagline}
        </Text>
      ) : null}
    </Box>
  )
}
