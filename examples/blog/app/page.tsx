import React from "react"
import { createClient } from "@/lib/supatype-server"
import type { AugmentedDatabase } from "@supatype/client"

type Post = AugmentedDatabase["public"]["Tables"]["post"]["Row"]

export default async function HomePage(): Promise<React.ReactElement> {
  const supatype = await createClient()
  const { data: posts, error } = await supatype
    .from("post")
    .select()
    .eq("status", "published")
    .order("published_at", { ascending: false })
    .limit(20)

  if (error !== null) return <p className="error">Error: {error.message}</p>
  if (posts === null || posts.length === 0) return <p className="empty">No posts yet.</p>

  return (
    <div>
      <h1>Recent posts</h1>
      <ul className="post-list">
        {posts.map((post: Post) => (
          <li key={post.id}>
            <a href={`/posts/${post.slug}`}>{post.title}</a>
            {post.published_at !== null && (
              <p className="meta">
                {new Date(post.published_at).toLocaleDateString("en-GB", {
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
