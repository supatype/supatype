"use client"

import React, { useCallback, useEffect, useMemo, useRef } from "react"
import type { SerializedEditorState } from "@supatype/types/lexical"
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
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  FORMAT_TEXT_COMMAND,
  type EditorState,
  type ElementNode,
  type LexicalEditor,
  type TextFormatType,
} from "lexical"
import { $createHeadingNode, HeadingNode, QuoteNode } from "@lexical/rich-text"
import { ListNode, ListItemNode, INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND } from "@lexical/list"
import { AutoLinkNode, LinkNode } from "@lexical/link"
import { $setBlocksType } from "@lexical/selection"
import clsx from "clsx"

const EDITOR_NODES = [HeadingNode, QuoteNode, ListNode, ListItemNode, LinkNode, AutoLinkNode]

/** Class names Lexical puts on content nodes. Exported for the package test, not from an entry. */
export const EDITOR_THEME = {
  heading: { h1: "su-rt-h1", h2: "su-rt-h2", h3: "su-rt-h3" },
  text: {
    bold: "su-rt-bold",
    italic: "su-rt-italic",
    underline: "su-rt-underline",
    strikethrough: "su-rt-strikethrough",
    underlineStrikethrough: "su-rt-underline-strikethrough",
  },
  list: { ul: "su-rt-ul", ol: "su-rt-ol", listitem: "su-rt-li" },
  link: "su-rt-link",
  paragraph: "su-rt-p",
  quote: "su-rt-quote",
}

/**
 * A toolbar button that acts on mouse down, with the default prevented so the editor keeps its
 * selection: a click would move focus to the button first and leave nothing selected to format.
 */
function ToolbarButton({
  title,
  onPress,
  children,
}: {
  title: string
  onPress: () => void
  children: React.ReactNode
}): React.ReactElement {
  return (
    <button type="button" title={title} onMouseDown={(e) => { e.preventDefault(); onPress() }}>
      {children}
    </button>
  )
}

/** Turn the selected blocks into the block `create` makes. */
function setBlocks(editor: LexicalEditor, create: () => ElementNode): void {
  editor.update(() => {
    const selection = $getSelection()
    if ($isRangeSelection(selection)) $setBlocksType(selection, create)
  })
}

function ToolbarPlugin(): React.ReactElement {
  const [editor] = useLexicalComposerContext()
  const format = useCallback((fmt: TextFormatType) => editor.dispatchCommand(FORMAT_TEXT_COMMAND, fmt), [editor])
  const heading = useCallback((tag: "h1" | "h2") => setBlocks(editor, () => $createHeadingNode(tag)), [editor])

  return (
    <div className="su-richtext-toolbar" role="toolbar" aria-label="Formatting">
      <ToolbarButton title="Bold" onPress={() => format("bold")}>B</ToolbarButton>
      <ToolbarButton title="Italic" onPress={() => format("italic")}>I</ToolbarButton>
      <ToolbarButton title="Underline" onPress={() => format("underline")}>U</ToolbarButton>
      <span className="su-richtext-toolbar-divider" aria-hidden />
      <ToolbarButton title="Heading 1" onPress={() => heading("h1")}>H1</ToolbarButton>
      <ToolbarButton title="Heading 2" onPress={() => heading("h2")}>H2</ToolbarButton>
      <ToolbarButton title="Paragraph" onPress={() => setBlocks(editor, () => $createParagraphNode())}>¶</ToolbarButton>
      <span className="su-richtext-toolbar-divider" aria-hidden />
      <ToolbarButton title="Bullet list" onPress={() => editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined)}>
        •
      </ToolbarButton>
      <ToolbarButton title="Numbered list" onPress={() => editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined)}>
        1.
      </ToolbarButton>
    </div>
  )
}

/**
 * Keeps the editor's editable state on the `editable` prop. Lexical reads `initialConfig` on mount
 * only, so a change to the prop after it swapped the toolbar but left the content as it was.
 */
function EditablePlugin({ editable }: { editable: boolean }): null {
  const [editor] = useLexicalComposerContext()
  useEffect(() => {
    editor.setEditable(editable)
  }, [editor, editable])
  return null
}

function InitialStatePlugin({ value }: { value: SerializedEditorState | null | undefined }): null {
  const [editor] = useLexicalComposerContext()
  const loaded = useRef(false)

  useEffect(() => {
    if (loaded.current) return
    loaded.current = true
    if (value !== null && value !== undefined && typeof value === "object") {
      try {
        const state = editor.parseEditorState(JSON.stringify(value))
        editor.setEditorState(state)
      } catch {
        editor.update(() => {
          const root = $getRoot()
          root.clear()
          root.append($createParagraphNode())
        })
      }
    }
  }, [editor, value])

  return null
}

export interface RichTextEditorProps {
  /** Initial document (Lexical JSON). Updates only on mount; use `documentKey` to reload. */
  value?: SerializedEditorState | null | undefined
  onChange: (json: SerializedEditorState) => void
  placeholder?: string | undefined
  className?: string | undefined
  editable?: boolean | undefined
  /** Change when switching documents so Lexical remounts with new `value`. */
  documentKey?: string | undefined
  /** `id` on the editable surface (e.g. for `<label htmlFor>`). */
  contentEditableId?: string | undefined
}

/**
 * Lexical-based rich text editor aligned with `@supatype/types` `RichText` / `SerializedEditorState`.
 *
 * Peer dependencies: `lexical`, `@lexical/react`, `@lexical/rich-text`, `@lexical/list`, `@lexical/link`, `@lexical/selection`.
 */
export function RichTextEditor({
  value,
  onChange,
  placeholder = "Write something…",
  className,
  editable = true,
  documentKey = "default",
  contentEditableId,
}: RichTextEditorProps): React.ReactElement {
  const initialConfig = useMemo(
    () => ({
      namespace: `supatype-richtext-${documentKey}`,
      theme: EDITOR_THEME,
      nodes: EDITOR_NODES,
      editable,
      onError: (err: Error) => {
        console.error("[RichTextEditor]", err)
      },
    }),
    [documentKey, editable],
  )

  const handleChange = useCallback(
    (editorState: EditorState, _editor: LexicalEditor) => {
      onChange(editorState.toJSON() as SerializedEditorState)
    },
    [onChange],
  )

  return (
    <div className={clsx("su-richtext", className, !editable && "su-richtext-readonly")}>
      <LexicalComposer key={documentKey} initialConfig={initialConfig}>
        {editable ? <ToolbarPlugin /> : null}
        <EditablePlugin editable={editable} />
        <InitialStatePlugin value={value} />
        <div className="su-richtext-surface">
          <RichTextPlugin
            contentEditable={
              <ContentEditable
                id={contentEditableId}
                className="su-richtext-editable"
                aria-label={placeholder}
              />
            }
            placeholder={<div className="su-richtext-placeholder">{placeholder}</div>}
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
