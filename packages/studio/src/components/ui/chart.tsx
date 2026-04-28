import * as React from "react"
import { ResponsiveContainer, Tooltip } from "recharts"

export type ChartConfig = Record<string, { label: string; color?: string }>

interface ChartContextValue {
  config: ChartConfig
}

const ChartContext = React.createContext<ChartContextValue>({ config: {} })

function useChart() {
  return React.useContext(ChartContext)
}

// Injects CSS variables like --color-signups from ChartConfig so Recharts
// stroke/fill can reference them as "var(--color-signups)".
export function ChartContainer({
  config,
  children,
  className,
}: {
  config: ChartConfig
  children: React.ReactElement
  className?: string
}) {
  const cssVars = Object.fromEntries(
    Object.entries(config).map(([key, val], i) => [
      `--color-${key}`,
      val.color ?? `hsl(${(i * 60 + 220) % 360} 70% 60%)`,
    ]),
  )

  return (
    <ChartContext.Provider value={{ config }}>
      <div className={className} style={cssVars as React.CSSProperties}>
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  )
}

export function ChartTooltipContent({
  active,
  payload,
  label,
  labelFormatter,
}: {
  active?: boolean
  payload?: Array<{ name: string; value: unknown; color?: string }>
  label?: string
  labelFormatter?: (label: string) => string
}) {
  const { config } = useChart()
  if (!active || !payload?.length) return null

  return (
    <div className="rounded-lg border border-border bg-background px-3 py-2 shadow-md text-xs">
      {label && (
        <p className="mb-1 font-medium text-foreground">
          {labelFormatter ? labelFormatter(label) : label}
        </p>
      )}
      {payload.map((entry) => (
        <div key={entry.name} className="flex items-center gap-2 text-muted-foreground">
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ background: entry.color ?? `var(--color-${entry.name})` }}
          />
          <span>{config[entry.name]?.label ?? entry.name}</span>
          <span className="ml-auto font-medium text-foreground">{String(entry.value)}</span>
        </div>
      ))}
    </div>
  )
}

export { Tooltip as ChartTooltip }
