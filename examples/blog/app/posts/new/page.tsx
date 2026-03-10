"use client"

import React, { useState, type FormEvent } from "react"
import { useRouter } from "next/navigation"
import { useAuth, useMutation } from "@supatype/react"
import type { Database } from "@/types/database"

type PostInsert = Database["public"]["Tables"]["posts"]["Insert"]

export default function NewPostPage(): React.ReactElement {
  const router = useRouter()
  const { user } = useAuth()
  const { mutate, loading, error } = useMutation<Database, "posts">("posts", "insert")

  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")

  if (user === null) {
    return (
      <div>
        <p>You must be signed in to create a post.</p>
        <a href="/login">Sign in</a>
      </div>
    )
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault()
    const post: PostInsert = {
      title,
      body,
      author_id: user!.id,
      status: "draft",
    }
    const result = await mutate(post)
    if (result !== undefined && result.error === null && result.data !== null && result.data.length > 0) {
      const created = result.data[0]
      if (created !== undefined) {
        router.push(`/posts/${created.slug}`)
      }
    }
  }

  return (
    <div>
      <h1>New post</h1>

      {error !== null && (
        <p style={{ color: "red" }}>{error.message}</p>
      )}

      <form onSubmit={(e) => { void handleSubmit(e) }}>
        <div style={{ marginBottom: "1rem" }}>
          <label htmlFor="post-title" style={{ display: "block", marginBottom: "0.25rem" }}>Title</label>
          <input
            id="post-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            style={{ width: "100%", padding: "0.5rem", fontSize: "1rem" }}
          />
        </div>

        <div style={{ marginBottom: "1rem" }}>
          <label htmlFor="post-body" style={{ display: "block", marginBottom: "0.25rem" }}>Body</label>
          <textarea
            id="post-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            required
            rows={10}
            style={{ width: "100%", padding: "0.5rem", fontSize: "1rem", fontFamily: "inherit" }}
          />
        </div>

        <button type="submit" disabled={loading}>
          {loading ? "Saving…" : "Save as draft"}
        </button>
      </form>
    </div>
  )
}
