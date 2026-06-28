import React from "react"
import { Box, Text } from "ink"
import type { DevReadyPanel } from "../../dev-ready-panel.js"
import { theme } from "../theme.js"

function truncate(text: string, width: number): string {
  if (width <= 0) return ""
  if (text.length <= width) return text
  if (width <= 1) return text.slice(0, width)
  return `${text.slice(0, width - 1)}…`
}

function shortenKey(key: string, width: number): string {
  if (key.length <= width) return key
  if (width <= 12) return truncate(key, width)
  return `${key.slice(0, width - 10)}…${key.slice(-8)}`
}

/** Inner text width inside the round border + horizontal padding. */
function panelInnerWidth(outerWidth: number): number {
  return Math.max(20, outerWidth - 4)
}

export function DevReadyPanelView({
  panel,
  width,
}: {
  panel: DevReadyPanel
  width: number
}): React.ReactElement {
  const innerWidth = panelInnerWidth(width)
  const labelWidth = 14

  return (
    <Box
      flexDirection="column"
      marginBottom={1}
      borderStyle="round"
      borderColor={theme.brand}
      paddingX={1}
    >
      <Text bold color={theme.brand}>
        {truncate(panel.title, innerWidth)}
      </Text>
      {panel.links.map((link) => (
        <Box key={`${link.label}-${link.url}`}>
          <Text dimColor>{truncate(link.label.padEnd(labelWidth), labelWidth)}</Text>
          <Text color={theme.info}>{truncate(link.url, innerWidth - labelWidth)}</Text>
        </Box>
      ))}
      {panel.hints?.map((hint) => (
        <Text key={hint} dimColor>
          {truncate(hint, innerWidth)}
        </Text>
      ))}
      {panel.anonKey ? (
        <>
          <Text dimColor>API keys (local dev)</Text>
          <Text dimColor>{`anon ${shortenKey(panel.anonKey, innerWidth - 5)}`}</Text>
          {panel.serviceRoleKey ? (
            <Text dimColor>{`svc  ${shortenKey(panel.serviceRoleKey, innerWidth - 5)}`}</Text>
          ) : null}
        </>
      ) : null}
    </Box>
  )
}
