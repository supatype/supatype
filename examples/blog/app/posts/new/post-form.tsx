"use client"

import React, { useCallback, useState, type FormEvent } from "react"
import { useRouter } from "next/navigation"
import { useMutation } from "@supatype/react"
import type { AugmentedDatabase, TableInsert } from "@supatype/client"
import {
  RichTextEditor,
  emptyRichTextDocument,
  richTextIsEmpty,
  type SerializedEditorState,
} from "@supatype/ui"

type NewPostFormProps = {
  userId: string
}

export function NewPostForm({ userId }: NewPostFormProps): React.ReactElement {
  const router = useRouter()
  const { mutate, loading, error } = useMutation<AugmentedDatabase, "post">("post", "insert")

  const [title, setTitle] = useState("")
  const [body, setBody] = useState<SerializedEditorState>(() => emptyRichTextDocument())
  const [bodyError, setBodyError] = useState<string | null>(null)

  const onBodyChange = useCallback((json: SerializedEditorState) => {
    setBody(json)
    setBodyError(null)
  }, [])

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault()
    if (richTextIsEmpty(body)) {
      setBodyError("Please add some body text.")
      return
    }
    const payload = {
      title,
      body,
      authorId: userId,
      status: "draft" as const,
    } satisfies TableInsert<"post">
    const result = await mutate(payload)
    if (result.error === null && result.data !== null && result.data.length > 0) {
      const created = result.data[0]
      if (created !== undefined) {
        router.push(`/posts/${created.slug}`)
      }
    }
  }

  return (
    <div>
      <h1>New post</h1>

      {error !== null && <p className="error">{error.message}</p>}

      <form onSubmit={(e) => { void handleSubmit(e) }}>
        <div className="form-group">
          <label htmlFor="post-title">Title</label>
          <input
            id="post-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
          />
        </div>

        <div className="form-group">
          <label htmlFor="post-body">Body</label>
          <RichTextEditor
            contentEditableId="post-body"
            value={body}
            onChange={onBodyChange}
            placeholder="Write your post…"
            className="post-body-editor"
          />
          {bodyError !== null && <p className="error">{bodyError}</p>}
        </div>

        <button type="submit" disabled={loading}>
          {loading ? "Saving…" : "Save as draft"}
        </button>
      </form>
    </div>
  )
}
