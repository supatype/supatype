import React, { useState } from "react"
import { Box, Text, useInput } from "ink"
import { FlowSpinner } from "../components/FlowSpinner.js"
import { LineInput } from "../components/LineInput.js"
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

/** The flow's log lines, with a blank line under them unless `gapBelow` is false. */
export function FlowLogPane({ lines, gapBelow = true }: { lines: FlowLogLine[]; gapBelow?: boolean }): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={gapBelow ? 1 : 0}>
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
        <Text dimColor>: {confirmPromptHint(value)}</Text>
      </Text>
    </Box>
  )
}

/**
 * The keys, with the answer enter gives as the capital letter (`Y/n`) and in words, so the default
 * is readable without colour.
 */
export function confirmPromptHint(selected: boolean): string {
  return selected ? "Y/n, ←/→, enter for yes" : "y/N, ←/→, enter for no"
}

interface TextPromptProps {
  spec: Extract<ActiveFlowPrompt, { kind: "text" }>
  onSubmit: (value: string) => void
  onCancel: () => void
}

type TextPromptSpec = Extract<ActiveFlowPrompt, { kind: "text" }>

/** What a text prompt shows besides its question: its default, or else an example of an answer. */
export interface TextPromptHints {
  /** Beside the question, for a default Enter gives: `(default 18478)`. */
  defaultHint?: string
  /** In the empty input, for a placeholder that is only an example: `e.g. api.example.com`. */
  example?: string
}

/**
 * A text prompt's hints. The input starts empty: the default used to be its text, so typing
 * appended to it (18478 then `8700` gave `184788700`). Then the default became the input's
 * placeholder, and a real default looked exactly like an example meaning "leave empty".
 */
export function textPromptHints(spec: TextPromptSpec): TextPromptHints {
  if (spec.defaultValue) return { defaultHint: `(default ${spec.defaultValue})` }
  return spec.placeholder ? { example: `e.g. ${spec.placeholder}` } : {}
}

/** The answer to a text prompt: what was typed, or its default when nothing was. */
export function textPromptAnswer(submitted: string, spec: TextPromptSpec): string {
  return submitted.trim() === "" ? (spec.defaultValue ?? submitted) : submitted
}

export function TextPrompt({ spec, onSubmit, onCancel }: TextPromptProps): React.ReactElement {
  const hints = textPromptHints(spec)
  const [value, setValue] = useState("")
  const [error, setError] = useState<string | undefined>()

  useInput((_input, key) => {
    if (key.escape) onCancel()
  })

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold color={theme.brand}>
          {spec.message}
        </Text>
        {hints.defaultHint !== undefined ? <Text dimColor> {hints.defaultHint}</Text> : null}
      </Text>
      <Box>
        <Text color={theme.brand}>› </Text>
        <LineInput
          value={value}
          onChange={(next) => {
            setValue(next)
            // A message about what was there before is wrong once it changes (issue 78).
            setError(undefined)
          }}
          onSubmit={(submitted) => {
            const answer = textPromptAnswer(submitted, spec)
            const err = spec.validate?.(answer)
            if (err) {
              setError(err)
              return
            }
            onSubmit(answer)
          }}
        />
        {value === "" && hints.example !== undefined ? <Text dimColor>{hints.example}</Text> : null}
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
        <LineInput mask="*" value={value} onChange={setValue} onSubmit={onSubmit} />
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
