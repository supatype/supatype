import React, { useEffect, useState } from "react"
import { Text, useInput, type Key } from "ink"

/** A one-line field's text and where the cursor is in it. */
export interface LineState {
  value: string
  cursor: number
}

/** The field after a key or a chunk of input, and whether that input submitted it. */
export interface LineEdit extends LineState {
  submit: boolean
}

/** The keys a line field acts on, as Ink reports them. */
export type LineKey = Pick<Key, "return" | "leftArrow" | "rightArrow" | "upArrow" | "downArrow" | "backspace" | "delete" | "tab" | "escape" | "ctrl">

const LINE_BREAKS: ReadonlySet<string> = new Set(["\r", "\n"])
const ERASE_BACK: ReadonlySet<string> = new Set(["\x7f", "\b"])

function eraseBack(state: LineState): LineState {
  if (state.cursor === 0) return state
  return { value: state.value.slice(0, state.cursor - 1) + state.value.slice(state.cursor), cursor: state.cursor - 1 }
}

/**
 * `input` applied a character at a time. Ink hands a burst of keys over as one string, as a paste
 * or a fast typist sends them, and that string used to go into the field whole: a pasted address
 * ending in a line break kept the `\r` and drew it raw, and Enter no longer submitted (issue 78).
 * A line break now submits, and stops there; a backspace in the burst erases.
 */
function typeChunk(state: LineState, input: string): LineEdit {
  let next = state
  for (const char of input) {
    if (LINE_BREAKS.has(char)) return { ...next, submit: true }
    if (ERASE_BACK.has(char)) next = eraseBack(next)
    else next = { value: next.value.slice(0, next.cursor) + char + next.value.slice(next.cursor), cursor: next.cursor + 1 }
  }
  return { ...next, submit: false }
}

/** The field after one input event from Ink. */
export function editLine(state: LineState, input: string, key: LineKey): LineEdit {
  if (key.upArrow || key.downArrow || key.tab || key.escape || key.ctrl) return { ...state, submit: false }
  if (key.return) return { ...state, submit: true }
  if (key.leftArrow) return { ...state, cursor: Math.max(0, state.cursor - 1), submit: false }
  if (key.rightArrow) return { ...state, cursor: Math.min(state.value.length, state.cursor + 1), submit: false }
  if (key.backspace || key.delete) return { ...eraseBack(state), submit: false }
  return typeChunk(state, input)
}

interface LineInputProps {
  value: string
  onChange: (value: string) => void
  onSubmit: (value: string) => void
  /** Drawn in place of each character, for a password. */
  mask?: string
}

/** A one-line text field for a flow's prompts. */
export function LineInput({ value, onChange, onSubmit, mask }: LineInputProps): React.ReactElement {
  const [cursor, setCursor] = useState(value.length)
  useEffect(() => {
    setCursor((at) => Math.min(at, value.length))
  }, [value])

  useInput((input, key) => {
    const next = editLine({ value, cursor }, input, key)
    setCursor(next.cursor)
    if (next.value !== value) onChange(next.value)
    if (next.submit) onSubmit(next.value)
  })

  const shown = mask === undefined ? value : mask.repeat(value.length)
  return (
    <Text>
      {shown.slice(0, cursor)}
      <Text inverse>{shown[cursor] ?? " "}</Text>
      {shown.slice(cursor + 1)}
    </Text>
  )
}
