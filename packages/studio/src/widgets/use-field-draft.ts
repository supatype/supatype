import { useCallback, useEffect, useRef, useState } from "react"

/**
 * What an editor is typing into a field, kept apart from the value the form holds.
 *
 * A widget whose text is not the stored value (`1h 30m` over `{ ms }`, two coordinate boxes over
 * EWKT) cannot rebuild its text from the value on every render: half-typed input such as `1h 3`
 * would be reformatted under the cursor. The draft follows the value only when the value changes
 * from outside, such as a record loading, and not when it is the widget's own last change coming
 * back.
 *
 * `draftOf` must be stable (a module-level function), since a new one each render resets the draft.
 */
export function useFieldDraft<T>(
  value: unknown,
  onChange: (value: unknown) => void,
  draftOf: (value: unknown) => T,
): { draft: T; setDraft: (draft: T) => void; update: (draft: T, value: unknown) => void } {
  const [draft, setDraft] = useState<T>(() => draftOf(value))
  const emitted = useRef<unknown>(value)

  useEffect(() => {
    if (Object.is(value, emitted.current)) return
    emitted.current = value
    setDraft(draftOf(value))
  }, [value, draftOf])

  const update = useCallback(
    (next: T, nextValue: unknown) => {
      setDraft(next)
      emitted.current = nextValue
      onChange(nextValue)
    },
    [onChange],
  )

  return { draft, setDraft, update }
}
