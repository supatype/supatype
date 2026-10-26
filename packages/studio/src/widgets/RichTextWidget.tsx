import React, { useCallback } from "react"
import type { WidgetProps } from "./FieldWidget.js"
import { LexicalComposer, type InitialConfigType } from "@lexical/react/LexicalComposer"
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
  type ElementNode,
  type LexicalEditor,
  type TextFormatType,
} from "lexical"
import { Card, IconButton } from "../components/ui.js"
import { cn } from "../lib/utils.js"
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

/** One toolbar button: what it is called, the glyph it shows, and what it does to the editor. */
interface Tool {
  label: string
  glyph: string
  run: (editor: LexicalEditor) => void
}

const formatTool = (label: string, glyph: string, fmt: TextFormatType): Tool =>
  ({ label, glyph, run: (editor) => { editor.dispatchCommand(FORMAT_TEXT_COMMAND, fmt) } })

/** Turns the blocks the selection touches into the block `create` makes. */
const blockTool = (label: string, glyph: string, create: () => ElementNode): Tool => ({
  label,
  glyph,
  run: (editor) => {
    editor.update(() => {
      const selection = $getSelection()
      if ($isRangeSelection(selection)) $setBlocksType(selection, create)
    })
  },
})

/** The toolbar's groups, in order; a divider stands between each. */
const TOOL_GROUPS: readonly (readonly Tool[])[] = [
  [formatTool("Bold", "B", "bold"), formatTool("Italic", "I", "italic"), formatTool("Underline", "U", "underline"), formatTool("Strikethrough", "S", "strikethrough")],
  [
    blockTool("Heading 1", "H1", () => $createHeadingNode("h1")),
    blockTool("Heading 2", "H2", () => $createHeadingNode("h2")),
    blockTool("Heading 3", "H3", () => $createHeadingNode("h3")),
    blockTool("Paragraph", "¶", () => $createParagraphNode()),
  ],
  [
    { label: "Bullet list", glyph: "•-", run: (editor) => { editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined) } },
    { label: "Numbered list", glyph: "1-", run: (editor) => { editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined) } },
  ],
]

/**
 * A toolbar button. Pressing the mouse on it does not take focus from the text, so the selection a
 * format applies to is still there; the act itself runs on click, which Enter and Space also send,
 * so the toolbar works from the keyboard as well as the pointer.
 */
function ToolButton({ tool, editor }: { tool: Tool; editor: LexicalEditor }): React.ReactElement {
  return (
    <IconButton label={tool.label} className="w-auto min-w-7 px-1.5 text-xs font-semibold text-foreground" onMouseDown={(e) => { e.preventDefault() }} onClick={() => { tool.run(editor) }}>
      {tool.glyph}
    </IconButton>
  )
}

function ToolbarPlugin(): React.ReactElement {
  const [editor] = useLexicalComposerContext()
  return (
    <div role="toolbar" aria-label="Formatting" className="flex flex-wrap items-center gap-0.5 border-b border-border bg-secondary px-1.5 py-1">
      {TOOL_GROUPS.map((group, i) => (
        <React.Fragment key={group[0]?.label ?? i}>
          {i > 0 && <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />}
          {group.map((tool) => <ToolButton key={tool.label} tool={tool} editor={editor} />)}
        </React.Fragment>
      ))}
    </div>
  )
}

// ── InitialStatePlugin: loads saved Lexical JSON on mount ────────────────────

function InitialStatePlugin({ value }: { value: unknown }): null {
  const [editor] = useLexicalComposerContext()
  const loaded = React.useRef(false)

  React.useEffect(() => {
    if (loaded.current) return
    loaded.current = true
    if (value !== null && value !== undefined && typeof value === "object") {
      try {
        const state = editor.parseEditorState(JSON.stringify(value))
        // Tagged so `OnChangePlugin` (which ignores history-merge updates) does not report loading
        // the saved value as an edit: that marked every record with rich text as changed on open.
        editor.setEditorState(state, { tag: "history-merge" })
      } catch {
        // Invalid saved state: leave editor empty
      }
    }
  }, [editor, value])

  return null
}

// ── Main widget ───────────────────────────────────────────────────────────────

/** The node classes the editor registers: everything a saved document can contain beyond Lexical's core. */
export const EDITOR_NODES = [HeadingNode, QuoteNode, ListNode, ListItemNode, LinkNode, AutoLinkNode]

/**
 * The classes Lexical puts on what it renders. Utility classes, so the document's type scale lives
 * with the design system rather than in a stylesheet of its own.
 */
const EDITOR_THEME = {
  heading: { h1: "mt-2 mb-1 text-[1.6rem] font-bold", h2: "mt-2 mb-1 text-[1.3rem] font-semibold", h3: "mt-2 mb-1 text-[1.1rem] font-semibold" },
  text: { bold: "font-bold", italic: "italic", underline: "underline", strikethrough: "line-through" },
  list: { ul: "my-1 list-disc pl-6", ol: "my-1 list-decimal pl-6", listitem: "my-0.5" },
  link: "cursor-pointer text-primary underline",
  paragraph: "my-1",
}

/**
 * The editable text and its placeholder. Named for the field, as a labelled input would be: a
 * `<label for>` names nothing that is not a form control.
 */
function EditableText({ config, readOnly, placeholder }: { config: WidgetProps["config"]; readOnly: boolean; placeholder: string }): React.ReactElement {
  return (
    <div className="relative">
      <RichTextPlugin
        contentEditable={<ContentEditable id={`field-${config.name}`} ariaLabel={config.label} className={cn("min-h-40 px-3 py-2.5 text-[0.9rem] leading-relaxed text-foreground outline-none", readOnly && "cursor-default bg-secondary")} />}
        placeholder={<div className="pointer-events-none absolute left-3 top-2.5 select-none text-[0.9rem] text-muted-foreground">{placeholder}</div>}
        ErrorBoundary={LexicalErrorBoundary}
      />
    </div>
  )
}

/** The editor's setup for a field: its own namespace, Studio's theme and nodes, and editable unless read only. */
function editorConfig(name: string, readOnly: boolean): InitialConfigType {
  return {
    namespace: `richtext-${name}`,
    theme: EDITOR_THEME,
    nodes: EDITOR_NODES,
    editable: !readOnly,
    onError: (err: Error) => { console.error("[RichTextWidget]", err) },
  }
}

export function RichTextWidget({ config, value, onChange, readOnly, localePlaceholder }: WidgetProps): React.ReactElement {
  const initialConfig = editorConfig(config.name, readOnly)

  const handleChange = useCallback((editorState: EditorState, _editor: LexicalEditor) => {
    onChange(editorState.toJSON())
  }, [onChange])

  return (
    <Card className="overflow-hidden rounded-md bg-background">
      <LexicalComposer initialConfig={initialConfig}>
        {!readOnly && <ToolbarPlugin />}
        <InitialStatePlugin value={value} />
        <EditableText config={config} readOnly={readOnly} placeholder={localePlaceholder ?? "Write something…"} />
        <HistoryPlugin />
        <ListPlugin />
        <LinkPlugin />
        <OnChangePlugin onChange={handleChange} ignoreSelectionChange />
      </LexicalComposer>
    </Card>
  )
}
