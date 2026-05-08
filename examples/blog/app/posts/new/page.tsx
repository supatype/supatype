import React from "react"
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supatype-server"
import { NewPostForm } from "@/app/posts/new/post-form"

export default async function NewPostPage(): Promise<React.ReactElement> {
  const supatype = await createClient()
  const { data, error } = await supatype.auth.getSession()
  const session = data.session

  if (error !== null || session === null) {
    redirect("/login?next=/posts/new")
  }

  return <NewPostForm userId={session.user.id} />
}
