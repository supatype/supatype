import React, { useEffect, useRef } from "react"
import { EditorView, basicSetup } from "codemirror"
import { EditorState, type Extension } from "@codemirror/state"
import { FieldFrame } from "../components/ui.js"

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

/** The latest change and blur handlers, read when an edit or a blur happens. */
interface EditorListeners {
  onChange: React.RefObject<((value: string) => void) | undefined>
  onBlur: React.RefObject<((value: string) => void) | undefined>
}

/** The editor's extensions: Studio's setup and theme, read-only when asked, the caller's, and the listeners. */
function editorExtensions(readOnly: boolean, extensions: Extension[], listeners: EditorListeners): Extension[] {
  return [
    basicSetup,
    studioEditorTheme,
    EditorView.editable.of(!readOnly),
    EditorState.readOnly.of(readOnly),
    ...extensions,
    EditorView.updateListener.of((update) => {
      if (update.docChanged) listeners.onChange.current?.(update.state.doc.toString())
    }),
    EditorView.domEventHandlers({
      blur: (_, view) => { listeners.onBlur.current?.(view.state.doc.toString()) },
    }),
  ]
}

/** Puts `value` into the editor when the parent changes it (a form reset, a locale switch). */
function useSyncedDoc(viewRef: React.RefObject<EditorView | null>, value: string): void {
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current !== value) view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
  }, [value])
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

  // Mount once: the editor owns its own state.
  useEffect(() => {
    if (!containerRef.current) return
    const allExtensions = editorExtensions(readOnly, extensions, { onChange: onChangeRef, onBlur: onBlurRef })
    const view = new EditorView({ state: EditorState.create({ doc: value, extensions: allExtensions }), parent: containerRef.current })
    viewRef.current = view
    return () => { view.destroy(); viewRef.current = null }
  }, []) // intentionally empty, editor created once
  useSyncedDoc(viewRef, value)

  return <div ref={containerRef} id={id} className={className} style={{ minHeight }} />
}

/**
 * The editor as a form field: in a field's frame, whose focus ring lights while the editor has
 * focus, at the height the field editors share. The JSON, XML and code widgets each drew this.
 */
export function FramedCodeEditor(props: CodeMirrorEditorProps): React.ReactElement {
  return (
    <FieldFrame className="block overflow-hidden p-0">
      <CodeMirrorEditor minHeight="180px" {...props} />
    </FieldFrame>
  )
}
