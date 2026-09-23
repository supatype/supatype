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

function ServiceLinkRow({
  label,
  url,
  innerWidth,
  labelWidth,
}: {
  label: string
  url: string
  innerWidth: number
  labelWidth: number
}): React.ReactElement {
  return (
    <Text wrap="truncate">
      <Text dimColor>{truncate(label.padEnd(labelWidth), labelWidth)}</Text>
      <Text color={theme.info}>{truncate(url, Math.max(8, innerWidth - labelWidth))}</Text>
    </Text>
  )
}

function CompactLinks({ panel, innerWidth }: { panel: DevReadyPanel; innerWidth: number }): React.ReactElement {
  const gateway = panel.links.find((link) => link.label === "API")?.url ?? panel.links[0]?.url ?? ""
  const studio =
    panel.links.find((link) => link.label === "Studio")?.url ??
    panel.links[panel.links.length - 1]?.url ??
    ""
  const otherPaths = panel.links
    .filter((link) => link.label !== "API" && link.label !== "Studio")
    .map((link) => {
      const prefix = `${link.url.split("://")[0] ?? "http"}://`
      const path = link.url.slice(link.url.indexOf("://") + 3)
      const slash = path.indexOf("/")
      return slash >= 0 ? path.slice(slash) : link.url
    })
    .join(", ")

  return (
    <>
      <Text wrap="truncate">
        <Text dimColor>{"Gateway".padEnd(14)}</Text>
        <Text color={theme.info}>{truncate(gateway, innerWidth - 14)}</Text>
      </Text>
      {otherPaths ? (
        <Text dimColor wrap="truncate">
          {truncate(`Also: ${otherPaths}`, innerWidth)}
        </Text>
      ) : null}
      {studio ? (
        <Text wrap="truncate">
          <Text dimColor>{"Studio".padEnd(14)}</Text>
          <Text color={theme.info}>{truncate(studio, innerWidth - 14)}</Text>
        </Text>
      ) : null}
    </>
  )
}

export function DevReadyPanelView({
  panel,
  width,
  compact = false,
}: {
  panel: DevReadyPanel
  width: number
  compact?: boolean
}): React.ReactElement {
  const innerWidth = panelInnerWidth(width)
  const labelWidth = 14

  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      width={width}
      marginBottom={1}
      borderStyle="round"
      borderColor={theme.brand}
      paddingX={1}
    >
      <Text bold color={theme.brand}>
        {truncate(panel.title, innerWidth)}
      </Text>
      {compact ? (
        <CompactLinks panel={panel} innerWidth={innerWidth} />
      ) : (
        panel.links.map((link) => (
          <ServiceLinkRow
            key={`${link.label}-${link.url}`}
            label={link.label}
            url={link.url}
            innerWidth={innerWidth}
            labelWidth={labelWidth}
          />
        ))
      )}
      {panel.hints?.map((hint) => (
        <Text key={hint} dimColor wrap="truncate">
          {truncate(hint, innerWidth)}
        </Text>
      ))}
      {panel.anonKey ? (
        <>
          <Text dimColor>API keys (local dev)</Text>
          <Text dimColor wrap="truncate">{`anon ${shortenKey(panel.anonKey, innerWidth - 5)}`}</Text>
          {panel.serviceRoleKey ? (
            <Text dimColor wrap="truncate">{`svc  ${shortenKey(panel.serviceRoleKey, innerWidth - 5)}`}</Text>
          ) : null}
        </>
      ) : null}
    </Box>
  )
}
