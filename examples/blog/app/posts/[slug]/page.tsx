import React from "react"
import { createClient } from "@/lib/supatype-server"
import { CommentsSection } from "./comments"
import type { Database } from "@/types/database"

type Post = Database["public"]["Tables"]["posts"]["Row"]

type Props = {
  params: Promise<{ slug: string }>
}

export default async function PostPage({ params }: Props): Promise<React.ReactElement> {
  const { slug } = await params
  const supatype = await createClient()
  const { data: posts, error } = await supatype
    .from("posts")
    .select()
    .eq("slug", slug)
    .eq("status", "published")
    .limit(1)

  if (error !== null) return <p>Error: {error.message}</p>
  const post: Post | null = posts?.[0] ?? null
  if (post === null) return <p>Post not found.</p>

  return (
    <article>
      <h1>{post.title}</h1>
      {post.published_at !== null && (
        <p style={{ color: "#666" }}>{new Date(post.published_at).toLocaleDateString()}</p>
      )}
      <div style={{ lineHeight: 1.7, margin: "2rem 0" }}>
        {post.body}
      </div>
      <CommentsSection postId={post.id} />
    </article>
  )
}
