import React, { useEffect, useRef } from "react"
import { EditorView, basicSetup } from "codemirror"
import { EditorState, type Extension } from "@codemirror/state"

const studioEditorTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "transparent",
      color: "hsl(var(--foreground))",
      fontSize: "0.8125rem",
      fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
    },
    ".cm-scroller": { overflowY: "auto" },
    ".cm-content": { padding: "12px 16px", caretColor: "hsl(var(--primary))" },
    ".cm-cursor": { borderLeftColor: "hsl(var(--primary))" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
      backgroundColor: "hsl(var(--accent))",
    },
    ".cm-activeLine": { backgroundColor: "rgba(255,255,255,0.04)" },
    ".cm-gutters": {
      backgroundColor: "hsl(var(--accent) / 0.3)",
      color: "hsl(var(--muted-foreground))",
      borderRight: "1px solid hsl(var(--border))",
      fontSize: "0.7rem",
      minWidth: "2.5rem",
    },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 4px" },
    ".cm-activeLineGutter": { backgroundColor: "transparent" },
    "&.cm-focused": { outline: "none" },
  },
  { dark: true },
)

interface CodeMirrorEditorProps {
  id?: string
  value: string
  onChange?: (value: string) => void
  onBlur?: (value: string) => void
  readOnly?: boolean
  extensions?: Extension[]
  className?: string
  minHeight?: string
}

export function CodeMirrorEditor({
  id,
  value,
  onChange,
  onBlur,
  readOnly = false,
  extensions = [],
  className,
  minHeight = "200px",
}: CodeMirrorEditorProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const onBlurRef = useRef(onBlur)

  useEffect(() => { onChangeRef.current = onChange }, [onChange])
  useEffect(() => { onBlurRef.current = onBlur }, [onBlur])

  // Mount once — editor owns its own state
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!containerRef.current) return

    const allExtensions: Extension[] = [
      basicSetup,
      studioEditorTheme,
      EditorView.editable.of(!readOnly),
      EditorState.readOnly.of(readOnly),
      ...extensions,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChangeRef.current?.(update.state.doc.toString())
      }),
      EditorView.domEventHandlers({
        blur: (_, view) => {
          onBlurRef.current?.(view.state.doc.toString())
        },
      }),
    ]

    const view = new EditorView({
      state: EditorState.create({ doc: value, extensions: allExtensions }),
      parent: containerRef.current,
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, []) // intentionally empty — editor created once

  // Sync value changes from parent (e.g. form reset / locale switch)
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current !== value) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
    }
  }, [value])

  return (
    <div
      ref={containerRef}
      id={id}
      className={className}
      style={{ minHeight }}
    />
  )
}
