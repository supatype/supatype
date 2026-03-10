"use client"

import React from "react"
import { useQuery } from "@supatype/react"
import type { Database } from "@/types/database"

type Post = Database["public"]["Tables"]["posts"]["Row"]

export default function HomePage(): React.ReactElement {
  const { data: posts, loading, error } = useQuery<Database, "posts">("posts", {
    filter: { status: "published" },
    order: { column: "published_at", ascending: false },
    limit: 20,
  })

  if (loading) return <p>Loading posts…</p>
  if (error !== null) return <p>Error: {error.message}</p>
  if (posts === null || posts.length === 0) return <p>No posts yet.</p>

  return (
    <div>
      <h1>Recent posts</h1>
      <ul style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: "1rem" }}>
        {posts.map((post) => (
          <li key={post.id} style={{ borderBottom: "1px solid #eee", paddingBottom: "1rem" }}>
            <a href={`/posts/${post.slug}`} style={{ fontWeight: "bold", fontSize: "1.2rem", textDecoration: "none" }}>
              {post.title}
            </a>
            {post.published_at !== null && (
              <p style={{ color: "#666", fontSize: "0.875rem", marginTop: "0.25rem" }}>
                {new Date(post.published_at).toLocaleDateString()}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
