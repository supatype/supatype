"use client"

import React from "react"
import { useQuery, useAuth, useMutation } from "@supatype/react"
import type { Database } from "@/types/database"

type Post = Database["public"]["Tables"]["posts"]["Row"]
type Comment = Database["public"]["Tables"]["comments"]["Row"]

export default function PostPage({ params }: { params: Promise<{ slug: string }> }): React.ReactElement {
  const { slug } = React.use(params)
  const { user } = useAuth()

  const { data: posts, loading: postLoading, error: postError } = useQuery<Database, "posts">("posts", {
    filter: { slug, status: "published" },
    limit: 1,
  })

  const post: Post | null = posts?.[0] ?? null

  const { data: comments, loading: commentsLoading, refetch } = useQuery<Database, "comments">("comments", {
    filter: post !== null ? { post_id: post.id } : undefined,
    order: { column: "created_at", ascending: true },
    enabled: post !== null,
  })

  const { mutate: addComment, loading: commenting } = useMutation<Database, "comments">("comments", "insert")

  const [commentBody, setCommentBody] = React.useState("")

  async function handleComment(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault()
    if (post === null || user === null) return
    await addComment({ post_id: post.id, author_id: user.id, body: commentBody })
    setCommentBody("")
    void refetch()
  }

  if (postLoading) return <p>Loading…</p>
  if (postError !== null) return <p>Error: {postError.message}</p>
  if (post === null) return <p>Post not found.</p>

  return (
    <article>
      <h1>{post.title}</h1>
      {post.published_at !== null && (
        <p style={{ color: "#666" }}>{new Date(post.published_at).toLocaleDateString()}</p>
      )}
      <div style={{ lineHeight: 1.7, margin: "2rem 0" }}>
        {/* In production this would be rendered rich text */}
        {post.body}
      </div>

      <section>
        <h2>Comments</h2>
        {commentsLoading && <p>Loading comments…</p>}
        {comments !== null && comments.length > 0 ? (
          <ul style={{ listStyle: "none", padding: 0 }}>
            {comments.map((comment: Comment) => (
              <li key={comment.id} style={{ borderBottom: "1px solid #eee", padding: "0.75rem 0" }}>
                {comment.body}
              </li>
            ))}
          </ul>
        ) : (
          !commentsLoading && <p>No comments yet.</p>
        )}

        {user !== null && (
          <form onSubmit={(e) => { void handleComment(e) }} style={{ marginTop: "1.5rem" }}>
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
    </article>
  )
}
