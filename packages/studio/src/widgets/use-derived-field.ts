import { useEffect, useLayoutEffect, useRef } from "react"
import type { WidgetProps } from "./FieldWidget.js"

/**
 * A field whose text is made from other fields (a slug from the title, a summary from several),
 * and which the editor can still type over.
 *
 * While creating a record (`slugFollowSource`) it follows its source as the source is typed, until
 * the editor types into it; from then it keeps their text. Refill copies the source in again and
 * follows it once more, and so does loading another record (`recordSyncKey`). `readOnly` only locks
 * the input: a field that follows its source on create still updates the draft, so a save includes it.
 */
export interface DerivedField {
  /** The editor typed `text`: it is handed to the form, and the field stops following its source. */
  type: (text: string) => void
  /** The source's text, handed to the form, and the field follows the source again. */
  refill: () => void
}

type DerivedProps = Pick<WidgetProps, "value" | "onChange" | "recordSyncKey" | "slugFollowSource">

/** Empty text is no value: the form gets null rather than "". */
const asValue = (text: string): string | null => (text === "" ? null : text)

export function useDerivedField(derived: string, { value, onChange, recordSyncKey, slugFollowSource = false }: DerivedProps): DerivedField {
  const text = value === null || value === undefined ? "" : String(value)
  /** The editor typed into the field; while true, following the source is paused. */
  const manualRef = useRef(false)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useLayoutEffect(() => {
    manualRef.current = false
  }, [recordSyncKey])

  useEffect(() => {
    if (!slugFollowSource || manualRef.current || derived === text) return
    onChangeRef.current(asValue(derived))
  }, [derived, slugFollowSource, text])

  return {
    type: (typed) => {
      manualRef.current = true
      onChange(asValue(typed))
    },
    refill: () => {
      manualRef.current = false
      onChange(asValue(derived))
    },
  }
}
