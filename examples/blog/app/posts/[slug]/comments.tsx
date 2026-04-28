"use client"

import React, { useState } from "react"
import { useAuth, useQuery, useMutation } from "@supatype/react"
import type { Database } from "@/types/database"

type Comment = Database["public"]["Tables"]["comments"]["Row"]

export function CommentsSection({ postId }: { postId: string }): React.ReactElement {
  const { user } = useAuth()
  const [commentBody, setCommentBody] = useState("")

  const { data: comments, loading, refetch } = useQuery<Database, "comments">("comments", {
    filter: { post_id: postId },
    order: { column: "created_at", ascending: true },
  })

  const { mutate: addComment, loading: commenting } = useMutation<Database, "comments">("comments", "insert")

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault()
    if (user === null) return
    await addComment({ post_id: postId, author_id: user.id, body: commentBody })
    setCommentBody("")
    void refetch()
  }

  return (
    <section>
      <h2>Comments</h2>
      {loading && <p>Loading comments…</p>}
      {comments !== null && comments.length > 0 ? (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {comments.map((comment: Comment) => (
            <li key={comment.id} style={{ borderBottom: "1px solid #eee", padding: "0.75rem 0" }}>
              {comment.body}
            </li>
          ))}
        </ul>
      ) : (
        !loading && <p>No comments yet.</p>
      )}

      {user !== null && (
        <form onSubmit={(e) => { void handleSubmit(e) }} style={{ marginTop: "1.5rem" }}>
          <textarea
            value={commentBody}
            onChange={(e) => setCommentBody(e.target.value)}
            required
            placeholder="Add a comment…"
            rows={3}
            style={{ width: "100%", padding: "0.5rem", fontFamily: "inherit" }}
          />
          <button type="submit" disabled={commenting} style={{ marginTop: "0.5rem" }}>
            {commenting ? "Posting…" : "Post comment"}
          </button>
        </form>
      )}
    </section>
  )
}
