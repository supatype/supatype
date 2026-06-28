import React, { type FC } from "react"
import { Box, Text, useInput } from "ink"
import SelectInput from "ink-select-input"
import { theme } from "../theme.js"
import type { DevSelectOption } from "../runtime/dev-prompt-queue.js"

export interface SelectFieldProps {
  message: string
  options: DevSelectOption[]
  initialValue?: string
  onSubmit: (value: string) => void
  onCancel: () => void
}

const BrandIndicator: FC<{ isSelected?: boolean }> = ({ isSelected }) => (
  <Text {...(isSelected ? { color: theme.brand, bold: true } : { dimColor: true })}>
    {isSelected ? "▸ " : "  "}
  </Text>
)

const BrandItem: FC<{ isSelected?: boolean; label: string }> = ({ isSelected, label }) => (
  <Text {...(isSelected ? { color: theme.brand, bold: true } : {})}>{label}</Text>
)

export function SelectField({
  message,
  options,
  initialValue,
  onSubmit,
  onCancel,
}: SelectFieldProps): React.ReactElement {
  useInput((_input, key) => {
    if (key.escape) onCancel()
  })

  const items = options.map((opt) => ({
    label: opt.hint ? `${opt.label} — ${opt.hint}` : opt.label,
    value: opt.value,
  }))

  const foundIndex = items.findIndex((item) => item.value === initialValue)

  return (
    <Box flexDirection="column">
      <Text bold color={theme.brand}>
        {message}
      </Text>
      <SelectInput
        items={items}
        {...(foundIndex >= 0 ? { initialIndex: foundIndex } : {})}
        indicatorComponent={BrandIndicator}
        itemComponent={BrandItem}
        onSelect={(item) => onSubmit(item.value)}
      />
      <Text dimColor>↑/↓ or j/k · enter · esc cancel · 1-9 quick pick</Text>
    </Box>
  )
}
