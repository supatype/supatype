<p align="center">
  <img src="https://raw.githubusercontent.com/supatype/.github/refs/heads/main/profile/supatype-icon.svg" width="60" alt="Supatype" />
</p>

# @supatype/react

React hooks for [Supatype](https://github.com/supatype/supatype) — typed queries, mutations, auth, realtime subscriptions, and more.

## Installation

```bash
npm i @supatype/react @supatype/client
```

Requires React 18+.

## Setup

Wrap your app with `SupatypeProvider`:

```tsx
import { SupatypeProvider } from "@supatype/react"
import { createClient } from "@supatype/client"
import type { Database } from "./types/database"

const client = createClient<Database>({
  url: process.env.NEXT_PUBLIC_SUPATYPE_URL!,
  anonKey: process.env.NEXT_PUBLIC_SUPATYPE_ANON_KEY!,
})

export default function App({ children }: { children: React.ReactNode }) {
  return <SupatypeProvider client={client}>{children}</SupatypeProvider>
}
```

## Hooks

### `useQuery`

Fetch data from a table with automatic caching and revalidation:

```tsx
import { useQuery } from "@supatype/react"

function PostList() {
  const { data: posts, loading, error } = useQuery((db) =>
    db.from("posts").select().eq("status", "published").order("created_at", { ascending: false })
  )

  if (loading) return <p>Loading…</p>
  if (error) return <p>Error: {error.message}</p>

  return (
    <ul>
      {posts?.map((post) => <li key={post.id}>{post.title}</li>)}
    </ul>
  )
}
```

### `useMutation`

Insert, update, delete, or upsert with loading and error state:

```tsx
import { useMutation } from "@supatype/react"

function CreatePost() {
  const { mutate, loading, error } = useMutation((db, input: { title: string; body: string }) =>
    db.from("posts").insert(input)
  )

  return (
    <button onClick={() => mutate({ title: "Hello", body: "World" })} disabled={loading}>
      Create post
    </button>
  )
}
```

### `useAuth`

Access and subscribe to the current user's auth state:

```tsx
import { useAuth } from "@supatype/react"

function Header() {
  const { user, session, loading, signIn, signOut } = useAuth()

  if (loading) return null
  if (!user) return <button onClick={() => signIn({ email: "…", password: "…" })}>Sign in</button>

  return (
    <div>
      <span>{user.email}</span>
      <button onClick={signOut}>Sign out</button>
    </div>
  )
}
```

### `useSubscription`

Subscribe to realtime table changes:

```tsx
import { useSubscription } from "@supatype/react"

function LivePosts() {
  const { status } = useSubscription(
    "posts",
    {
      event: "*",
      filter: "status=eq.published",
    },
    (payload) => {
      console.log("change:", payload)
    }
  )
}
```

### `useFunction`

Call an edge function with loading and error state:

```tsx
import { useFunction } from "@supatype/react"

function SendEmailButton() {
  const { invoke, loading } = useFunction("send-email")

  return (
    <button onClick={() => invoke({ to: "user@example.com" })} disabled={loading}>
      Send email
    </button>
  )
}
```

### `useLivePreview`

Subscribe to Studio live-preview events for a model:

```tsx
import { useLivePreview } from "@supatype/react"

function PreviewPost({ id }: { id: string }) {
  const { data: post } = useLivePreview<Post>("posts", id)
  return <article>{post?.title}</article>
}
```

### `useSupatype`

Access the underlying client directly:

```tsx
import { useSupatype } from "@supatype/react"

function MyComponent() {
  const client = useSupatype()
  // client is a fully-typed SupatypeClient
}
```

## `RichText` component

Render Lexical rich-text content stored in the database:

```tsx
import { RichText } from "@supatype/react"

function PostBody({ body }: { body: string | object }) {
  return <RichText content={body} />
}
```

## Docs

Full documentation: [supatype.github.io/supatype](https://supatype.github.io/supatype/)
