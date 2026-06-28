import React, { useState } from "react"
import { Box, Text, useInput } from "ink"
import TextInput from "ink-text-input"
import { FlowSpinner } from "../components/FlowSpinner.js"
import { LogoWordmark } from "../components/LogoWordmark.js"
import { SelectField } from "../components/SelectField.js"
import { theme } from "../theme.js"
import type { ActiveFlowPrompt, FlowLogLine } from "./types.js"

const TASK_COL_WIDTH = 22

function flowLogLineProps(level: FlowLogLine["level"]): { color?: string; dimColor?: boolean } {
  if (level === "plain") return { dimColor: true }
  if (level === "warn") return { color: theme.warn }
  if (level === "error") return { color: theme.error }
  if (level === "success") return { color: theme.success }
  return { color: theme.info }
}

export function FlowLogoHeader(): React.ReactElement {
  return <LogoWordmark />
}

export function FlowLogPane({ lines }: { lines: FlowLogLine[] }): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {lines.map((line, index) => (
        <Text key={`${index}-${line.text.slice(0, 24)}`} {...flowLogLineProps(line.level)}>
          {line.text}
        </Text>
      ))}
    </Box>
  )
}

export function FlowSpinnerLine({ message }: { message: string }): React.ReactElement {
  return <FlowSpinner message={message} />
}

interface ConfirmPromptProps {
  spec: Extract<ActiveFlowPrompt, { kind: "confirm" }>
  onSubmit: (value: boolean) => void
}

export function ConfirmPrompt({ spec, onSubmit }: ConfirmPromptProps): React.ReactElement {
  const [value, setValue] = useState(spec.initialValue)

  useInput((input, key) => {
    if (input === "y" || input === "Y") {
      onSubmit(true)
      return
    }
    if (input === "n" || input === "N") {
      onSubmit(false)
      return
    }
    if (key.leftArrow || input === "h") setValue(false)
    if (key.rightArrow || input === "l") setValue(true)
    if (key.return) onSubmit(value)
  })

  return (
    <Box flexDirection="column">
      <Text bold color={theme.brand}>
        {spec.message}
      </Text>
      <Text>
        {value ? (
          <Text color={theme.brand} bold>
            Yes
          </Text>
        ) : (
          <Text dimColor>Yes</Text>
        )}
        <Text dimColor> / </Text>
        {!value ? (
          <Text color={theme.brand} bold>
            No
          </Text>
        ) : (
          <Text dimColor>No</Text>
        )}
        <Text dimColor> — y/n, ←/→, enter</Text>
      </Text>
    </Box>
  )
}

interface TextPromptProps {
  spec: Extract<ActiveFlowPrompt, { kind: "text" }>
  onSubmit: (value: string) => void
  onCancel: () => void
}

export function TextPrompt({ spec, onSubmit, onCancel }: TextPromptProps): React.ReactElement {
  const [value, setValue] = useState(spec.defaultValue ?? "")
  const [error, setError] = useState<string | undefined>()

  useInput((_input, key) => {
    if (key.escape) onCancel()
  })

  return (
    <Box flexDirection="column">
      <Text bold color={theme.brand}>
        {spec.message}
      </Text>
      <Box>
        <Text color={theme.brand}>› </Text>
        <TextInput
          value={value}
          {...(spec.placeholder !== undefined ? { placeholder: spec.placeholder } : {})}
          onChange={setValue}
          onSubmit={(submitted) => {
            const err = spec.validate?.(submitted)
            if (err) {
              setError(err)
              return
            }
            onSubmit(submitted)
          }}
        />
      </Box>
      {error ? <Text color={theme.error}>{error}</Text> : null}
      <Text dimColor>enter submit · esc cancel</Text>
    </Box>
  )
}

interface PasswordPromptProps {
  spec: Extract<ActiveFlowPrompt, { kind: "password" }>
  onSubmit: (value: string) => void
  onCancel: () => void
}

export function PasswordPrompt({ spec, onSubmit, onCancel }: PasswordPromptProps): React.ReactElement {
  const [value, setValue] = useState("")

  useInput((_input, key) => {
    if (key.escape) onCancel()
  })

  return (
    <Box flexDirection="column">
      <Text bold color={theme.brand}>
        {spec.message}
      </Text>
      <Box>
        <Text color={theme.brand}>› </Text>
        <TextInput mask="*" value={value} onChange={setValue} onSubmit={onSubmit} />
      </Box>
      <Text dimColor>enter submit · esc cancel</Text>
    </Box>
  )
}

interface SelectPromptProps {
  spec: Extract<ActiveFlowPrompt, { kind: "select" }>
  onSubmit: (value: string) => void
  onCancel: () => void
}

export function SelectPrompt({ spec, onSubmit, onCancel }: SelectPromptProps): React.ReactElement {
  return (
    <SelectField
      message={spec.message}
      options={spec.options}
      {...(spec.initialValue !== undefined ? { initialValue: spec.initialValue } : {})}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  )
}

export function ActiveFlowPromptView({
  prompt,
  onSubmit,
  onCancel,
}: {
  prompt: ActiveFlowPrompt
  onSubmit: (value: unknown) => void
  onCancel: () => void
}): React.ReactElement {
  switch (prompt.kind) {
    case "confirm":
      return <ConfirmPrompt spec={prompt} onSubmit={(v) => onSubmit(v)} />
    case "text":
      return <TextPrompt spec={prompt} onSubmit={(v) => onSubmit(v)} onCancel={onCancel} />
    case "password":
      return <PasswordPrompt spec={prompt} onSubmit={(v) => onSubmit(v)} onCancel={onCancel} />
    case "select":
      return <SelectPrompt spec={prompt} onSubmit={(v) => onSubmit(v)} onCancel={onCancel} />
    default:
      return <Text>Unsupported prompt</Text>
  }
}

export { TASK_COL_WIDTH }
