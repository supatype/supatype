"use client"

import React, { useState } from "react"
import { useAuth, useQuery, useMutation } from "@supatype/react"
import type { AugmentedDatabase } from "@supatype/client"

type Comment = AugmentedDatabase["public"]["Tables"]["comment"]["Row"]

export function CommentsSection({ postId }: { postId: string }): React.ReactElement {
  const { user } = useAuth()
  const [commentBody, setCommentBody] = useState("")

  const { data: comments, loading, refetch } = useQuery<AugmentedDatabase, "comment">("comment", {
    filter: { postId },
    order: { column: "created_at", ascending: true },
  })

  const { mutate: addComment, loading: commenting } = useMutation<AugmentedDatabase, "comment">("comment", "insert")

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault()
    if (user === null) return
    await addComment({ postId, authorId: user.id, body: commentBody })
    setCommentBody("")
    void refetch()
  }

  return (
    <section className="comments">
      <h2>Comments</h2>

      {loading && <p className="text-muted">Loading comments…</p>}

      {comments !== null && comments.length > 0 ? (
        <ul className="comment-list">
          {comments.map((comment: Comment) => (
            <li key={comment.id}>{comment.body}</li>
          ))}
        </ul>
      ) : (
        !loading && <p className="empty">No comments yet.</p>
      )}

      {user !== null && (
        <form onSubmit={(e) => { void handleSubmit(e) }} style={{ marginTop: "1.5rem" }}>
          <div className="form-group">
            <textarea
              value={commentBody}
              onChange={(e) => setCommentBody(e.target.value)}
              required
              placeholder="Add a comment…"
              rows={3}
            />
          </div>
          <button type="submit" disabled={commenting}>
            {commenting ? "Posting…" : "Post comment"}
          </button>
        </form>
      )}
    </section>
  )
}
