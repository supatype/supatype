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
  $getSelection,
  $isRangeSelection,
  FORMAT_TEXT_COMMAND,
  type EditorState,
  type LexicalEditor,
  type TextFormatType,
} from "lexical"
import { $createHeadingNode, HeadingNode, QuoteNode } from "@lexical/rich-text"
import { ListNode, ListItemNode, INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND } from "@lexical/list"
import { AutoLinkNode, LinkNode } from "@lexical/link"
import { $setBlocksType } from "@lexical/selection"
import { $createParagraphNode, $getRoot } from "lexical"
import clsx from "clsx"

const EDITOR_NODES = [HeadingNode, QuoteNode, ListNode, ListItemNode, LinkNode, AutoLinkNode]

const EDITOR_THEME = {
  heading: { h1: "su-rt-h1", h2: "su-rt-h2", h3: "su-rt-h3" },
  text: { bold: "su-rt-bold", italic: "su-rt-italic", underline: "su-rt-underline", strikethrough: "su-rt-strikethrough" },
  list: { ul: "su-rt-ul", ol: "su-rt-ol", listitem: "su-rt-li" },
  link: "su-rt-link",
  paragraph: "su-rt-p",
}

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
    <div className="su-richtext-toolbar" role="toolbar" aria-label="Formatting">
      <button type="button" title="Bold" onMouseDown={(e) => { e.preventDefault(); format("bold") }}>
        B
      </button>
      <button type="button" title="Italic" onMouseDown={(e) => { e.preventDefault(); format("italic") }}>
        I
      </button>
      <button type="button" title="Underline" onMouseDown={(e) => { e.preventDefault(); format("underline") }}>
        U
      </button>
      <span className="su-richtext-toolbar-divider" aria-hidden />
      <button type="button" title="Heading 1" onMouseDown={(e) => { e.preventDefault(); setHeading("h1") }}>
        H1
      </button>
      <button type="button" title="Heading 2" onMouseDown={(e) => { e.preventDefault(); setHeading("h2") }}>
        H2
      </button>
      <button type="button" title="Paragraph" onMouseDown={(e) => { e.preventDefault(); setParagraph() }}>
        ¶
      </button>
      <span className="su-richtext-toolbar-divider" aria-hidden />
      <button
        type="button"
        title="Bullet list"
        onMouseDown={(e) => {
          e.preventDefault()
          editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined)
        }}
      >
        •
      </button>
      <button
        type="button"
        title="Numbered list"
        onMouseDown={(e) => {
          e.preventDefault()
          editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined)
        }}
      >
        1.
      </button>
    </div>
  )
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
