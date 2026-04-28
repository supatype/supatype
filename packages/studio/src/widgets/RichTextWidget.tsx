import React, { useCallback } from "react"
import type { WidgetProps } from "./FieldWidget.js"
import { LexicalComposer } from "@lexical/react/LexicalComposer"
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin"
import { ContentEditable } from "@lexical/react/LexicalContentEditable"
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin"
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin"
import { ListPlugin } from "@lexical/react/LexicalListPlugin"
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin"
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary"
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext"
import {
  $getSelection,
  $isRangeSelection,
  FORMAT_TEXT_COMMAND,
  type EditorState,
  type LexicalEditor,
  type TextFormatType,
} from "lexical"
import {
  $createHeadingNode,
  $isHeadingNode,
  HeadingNode,
  QuoteNode,
} from "@lexical/rich-text"
import { ListNode, ListItemNode, INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND } from "@lexical/list"
import { AutoLinkNode, LinkNode } from "@lexical/link"
import { $setBlocksType } from "@lexical/selection"
import { $getRoot, $createParagraphNode } from "lexical"

// ── Toolbar ───────────────────────────────────────────────────────────────────

function ToolbarPlugin(): React.ReactElement {
  const [editor] = useLexicalComposerContext()

  const format = useCallback((fmt: TextFormatType) => {
    editor.dispatchCommand(FORMAT_TEXT_COMMAND, fmt)
  }, [editor])

  const setHeading = useCallback((tag: "h1" | "h2" | "h3") => {
    editor.update(() => {
      const selection = $getSelection()
      if ($isRangeSelection(selection)) {
        $setBlocksType(selection, () => $createHeadingNode(tag))
      }
    })
  }, [editor])

  const setParagraph = useCallback(() => {
    editor.update(() => {
      const selection = $getSelection()
      if ($isRangeSelection(selection)) {
        $setBlocksType(selection, () => $createParagraphNode())
      }
    })
  }, [editor])

  return (
    <div className="st-richtext-toolbar">
      <button type="button" title="Bold" onMouseDown={(e) => { e.preventDefault(); format("bold") }}>B</button>
      <button type="button" title="Italic" onMouseDown={(e) => { e.preventDefault(); format("italic") }}>I</button>
      <button type="button" title="Underline" onMouseDown={(e) => { e.preventDefault(); format("underline") }}>U</button>
      <button type="button" title="Strikethrough" onMouseDown={(e) => { e.preventDefault(); format("strikethrough") }}>S</button>
      <span className="st-richtext-divider" />
      <button type="button" title="Heading 1" onMouseDown={(e) => { e.preventDefault(); setHeading("h1") }}>H1</button>
      <button type="button" title="Heading 2" onMouseDown={(e) => { e.preventDefault(); setHeading("h2") }}>H2</button>
      <button type="button" title="Heading 3" onMouseDown={(e) => { e.preventDefault(); setHeading("h3") }}>H3</button>
      <button type="button" title="Paragraph" onMouseDown={(e) => { e.preventDefault(); setParagraph() }}>¶</button>
      <span className="st-richtext-divider" />
      <button type="button" title="Bullet list" onMouseDown={(e) => { e.preventDefault(); editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined) }}>•—</button>
      <button type="button" title="Numbered list" onMouseDown={(e) => { e.preventDefault(); editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined) }}>1—</button>
    </div>
  )
}

// ── InitialStatePlugin — loads saved Lexical JSON on mount ────────────────────

function InitialStatePlugin({ value }: { value: unknown }): null {
  const [editor] = useLexicalComposerContext()
  const loaded = React.useRef(false)

  React.useEffect(() => {
    if (loaded.current) return
    loaded.current = true
    if (value !== null && value !== undefined && typeof value === "object") {
      try {
        const state = editor.parseEditorState(JSON.stringify(value))
        editor.setEditorState(state)
      } catch {
        // Invalid saved state — leave editor empty
      }
    }
  }, [editor, value])

  return null
}

// ── Main widget ───────────────────────────────────────────────────────────────

const EDITOR_NODES = [HeadingNode, QuoteNode, ListNode, ListItemNode, LinkNode, AutoLinkNode]

const EDITOR_THEME = {
  heading: { h1: "st-rt-h1", h2: "st-rt-h2", h3: "st-rt-h3" },
  text: { bold: "st-rt-bold", italic: "st-rt-italic", underline: "st-rt-underline", strikethrough: "st-rt-strikethrough" },
  list: { ul: "st-rt-ul", ol: "st-rt-ol", listitem: "st-rt-li" },
  link: "st-rt-link",
  paragraph: "st-rt-p",
}

export function RichTextWidget({ config, value, onChange, readOnly }: WidgetProps): React.ReactElement {
  const initialConfig = {
    namespace: `richtext-${config.name}`,
    theme: EDITOR_THEME,
    nodes: EDITOR_NODES,
    editable: !readOnly,
    onError: (err: Error) => { console.error("[RichTextWidget]", err) },
  }

  const handleChange = useCallback((editorState: EditorState, _editor: LexicalEditor) => {
    onChange(editorState.toJSON())
  }, [onChange])

  return (
    <div className={`st-richtext-widget${readOnly ? " st-richtext-readonly" : ""}`}>
      <LexicalComposer initialConfig={initialConfig}>
        {!readOnly && <ToolbarPlugin />}
        <InitialStatePlugin value={value} />
        <div className="st-richtext-container">
          <RichTextPlugin
            contentEditable={<ContentEditable className="st-richtext-content" />}
            placeholder={<div className="st-richtext-placeholder">Write something…</div>}
            ErrorBoundary={LexicalErrorBoundary}
          />
        </div>
        <HistoryPlugin />
        <ListPlugin />
        <LinkPlugin />
        <OnChangePlugin onChange={handleChange} ignoreSelectionChange />
      </LexicalComposer>
    </div>
  )
}
