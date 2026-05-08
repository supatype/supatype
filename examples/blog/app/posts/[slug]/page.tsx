import React from "react"
import { createClient } from "@/lib/supatype-server"
import { RichText } from "@supatype/react"
import { CommentsSection } from "./comments"
import type { AugmentedDatabase } from "@supatype/client"

type Post = AugmentedDatabase["public"]["Tables"]["post"]["Row"]

type Props = {
  params: Promise<{ slug: string }>
}

export default async function PostPage({ params }: Props): Promise<React.ReactElement> {
  const { slug } = await params
  const supatype = await createClient()
  const { data: posts, error } = await supatype
    .from("post")
    .select()
    .eq("slug", slug)
    .eq("status", "published")
    .limit(1)

  if (error !== null) return <p className="error">Error: {error.message}</p>
  const post: Post | null = posts?.[0] ?? null
  if (post === null) return <p className="empty">Post not found.</p>

  return (
    <article>
      <h1>{post.title}</h1>
      {post.published_at !== null && (
        <p className="article-meta">
          {new Date(post.published_at).toLocaleDateString("en-GB", {
            day: "numeric",
            month: "long",
            year: "numeric",
          })}
        </p>
      )}
      <RichText content={post.body as any} className="richtext" />
      <CommentsSection postId={post.id} />
    </article>
  )
}
