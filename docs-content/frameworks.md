---
title: "Frameworks"
description: "Use Supatype from React, Vue, Svelte, Solid, React Native and Next.js server code: providers, query and mutation hooks, live preview, and cookie-based server clients."
head:
  - tag: title
    content: "Frameworks | Supatype"
  - tag: meta
    attrs:
      property: "og:image"
      content: "https://www.supatype.com/og/frameworks.png"
---

Supatype has bindings for React, Vue, Svelte and Solid, a React Native helper, and a server helper for Next.js. Each one wraps the client you already create, so everything on the [Client](/docs/client.html) page still applies.

<h2 id="packages">Packages</h2>

| Package | Exports |
| --- | --- |
| `@supatype/react` | `SupatypeProvider`, `useSupatype`, `useQuery`, `useMutation`, `useFunction`, `useAuth`, `useSubscription`, `useLivePreview`, `RichText` |
| `@supatype/vue` | `supatypePlugin`, `useSupatype`, `useQuery`, `useMutation`, `useFunction`, `useAuth`, `useSubscription` |
| `@supatype/svelte` | `setSupatypeClient`, `getSupatypeClient`, `createQuery`, `createMutation`, `createFunction`, `createAuth`, `createSubscription` |
| `@supatype/solid` | `SupatypeContext`, `useSupatype`, `createQuery`, `createMutation`, `createFunction`, `createAuth`, `createSubscription` |
| `@supatype/react-native` | `createNativeClient`, `secureStoreAdapter`, `asyncStorageAdapter`, `openOAuth`, `createAuthUrlListener` |
| `@supatype/ssr` | `createServerClient` |

Every example below imports the client from `src/supatype.ts`, created once as shown in [Client: Create the client](/docs/client.html#setup). With Vite, read the values `supatype keys` writes to `.env`:

```ts title="src/supatype.ts"
import { createClient } from "../supatype/generated/client"

export const supatype = createClient({
  url: import.meta.env.VITE_SUPATYPE_URL,
  anonKey: import.meta.env.VITE_SUPATYPE_ANON_KEY,
})
```

Sign-in screens are covered on [Auth: Pre-built UI](/docs/auth.html#ui), and the subscription hooks on [Realtime: Framework hooks](/docs/realtime.html#hooks). This page does not repeat them.

<h2 id="react">React</h2>

Wrap your app in `SupatypeProvider` and pass the client. Every hook reads the client from it and throws when there is no provider above it.

```tsx title="src/Posts.tsx"
import { SupatypeProvider, useQuery, useMutation, useFunction } from "@supatype/react"
import { supatype } from "./supatype"

function Posts() {
  const { data: posts, loading, error, refetch } = useQuery("post", {
    select: "id, title, slug",
    order: { column: "title" },
    limit: 20,
  })
  const { mutate: removePost } = useMutation("post", "delete")
  const { invoke: greet, data: reply } = useFunction<{ greeting: string }>("greet")

  if (loading) return <p>Loading</p>
  if (error) return <p>{error.message}</p>
  return (
    <ul>
      {posts?.map((post) => (
        <li key={post.id}>
          {post.title}
          <button onClick={async () => { await removePost(undefined, { filter: { id: post.id } }); refetch() }}>Delete</button>
        </li>
      ))}
      <button onClick={() => greet({ name: "Alex" })}>{reply?.greeting ?? "Say hello"}</button>
    </ul>
  )
}

export function App() {
  return <SupatypeProvider client={supatype}><Posts /></SupatypeProvider>
}
```

### useQuery

`useQuery(table, options)` returns `data`, `error`, `count`, `loading` and `refetch`. It runs again when the options change, and when a different user signs in or out.

| Option | What it does |
| --- | --- |
| `select` | The select expression. Default `*`. |
| `filter` | Equality filters, one per column. |
| `order` | `{ column, ascending }`. Ascending by default. |
| `limit`, `offset` | Paging. `offset` only applies when `limit` is set. |
| `enabled` | `false` skips the query. |
| `refetchInterval` | Runs the query again every so many milliseconds. |
| `cache` | The same cache options as the client's `.cache()`. |
| `draft` | Reads saved drafts instead of published rows, on a model with drafts. See [Drafts and publishing](/docs/client.html#drafts). |

For anything `filter` cannot say, such as ranges or embeds with conditions, use the client directly through `useSupatype()`.

### useMutation and useFunction

`useMutation(table, operation)` takes `"insert"`, `"update"`, `"delete"` or `"upsert"` and returns `mutate`, `loading` and `error`. `mutate(data, { filter, publish })` takes the rows to write; `filter` picks the rows for an update or delete, and `publish: true` publishes the drafts an update saves. It does not ask for the written rows back, so call `refetch` on your query afterwards.

`mutate` resolves with `{ data, error, count }`. There are no `onMutate`, `onSuccess` or `onError` callbacks, so an optimistic update and its rollback are yours to write.

`useFunction(name)` returns `invoke`, `data`, `error` and `loading`. `invoke(body, { method, headers })` calls `supatype.functions.invoke`. See [Functions: Call a function](/docs/functions.html#call).

`useAuth()` returns `user`, `session`, `loading`, `error`, `signUp`, `signIn` (email and password), `signInWithOAuth`, `signInWithOtp` and `signOut`, and re-renders when the session changes. For anything else, such as MFA or a password reset, call `useSupatype().auth`. See [Auth](/docs/auth.html).

### Live preview

Studio can show your app in a pane beside the edit form and stream the unsaved values into it as the editor types. Tell Studio where a record's page lives in `supatype.config.ts`:

```ts title="supatype.config.ts"
export default defineConfig({
  // ...
  admin: { livePreview: { Post: { urlPattern: "https://example.com/preview/{slug}" } } },
})
```

A path such as `"/preview/{slug}"` is enough when the same deployment serves your app (`app.mode` set to `static` or `proxy`). With `app.mode: "none"`, `supatype push` refuses a path and wants the full URL.

On that page, `useLivePreview` returns the live values while Studio is sending them and your own data otherwise:

```tsx title="src/PostPreview.tsx"
import { useLivePreview, RichText } from "@supatype/react"

export function PostPreview({ post }: { post: Post }) {
  const { data, isPreview } = useLivePreview({ initialData: post })
  return (
    <article>
      {isPreview && <p>Preview</p>}
      <h1>{data.title}</h1>
      <RichText content={data.body} />
    </article>
  )
}
```

A message is applied only when it comes from the window framing the page, at a Studio origin. By default that is the origin of the provider's client URL, since Studio is served at `/studio/` on your API. If Studio is served somewhere else, or the page has no provider, pass `studioOrigin` with one URL or a list. Messages from any other origin are ignored with a console warning. `model` limits the hook to messages for one model.

This is the unsaved form state. To show the last saved draft instead, use `useQuery` with `draft: true`.

### RichText

`RichText` renders a saved rich text field as React elements. Text is rendered as text, never as HTML, and links keep only a safe `href`. It works in Server Components and Client Components. Props are `content`, `className`, and `as` to choose the wrapper: `div` (the default), `article`, `section`, `aside` or `main`. A `null` content renders nothing.

<h2 id="vue">Vue</h2>

Install the plugin with your client. The composables must be called inside `setup`.

```ts title="src/main.ts"
import { createApp } from "vue"
import { supatypePlugin } from "@supatype/vue"
import { supatype } from "./supatype"
import App from "./App.vue"

createApp(App).use(supatypePlugin, supatype).mount("#app")
```

```vue title="src/Posts.vue"
<script setup lang="ts">
import { useQuery, useMutation } from "@supatype/vue"

const { data: posts, loading, refetch } = useQuery("post", { columns: "id, title", limit: 20 })
const { mutate: removePost } = useMutation("post", "delete")

async function remove(id: string) {
  await removePost(undefined, { filter: { id } })
  await refetch()
}
</script>

<template>
  <p v-if="loading">Loading</p>
  <ul v-else>
    <li v-for="post in posts" :key="post.id">
      {{ post.title }} <button @click="remove(post.id)">Delete</button>
    </li>
  </ul>
</template>
```

Results are refs. The query runs when the component mounts. `enabled` may be a ref; the query runs again when it turns `true`. `useFunction(name)` returns `invoke(body)`, `data`, `error` and `loading`.

<h2 id="svelte">Svelte</h2>

Set the client once in a parent component. The `create*` functions read it from context, so call them during component setup, then read the stores with `$`.

```svelte title="src/App.svelte"
<script lang="ts">
  import { setSupatypeClient } from "@supatype/svelte"
  import { supatype } from "./supatype"
  import Posts from "./Posts.svelte"

  setSupatypeClient(supatype)
</script>

<Posts />
```

```svelte title="src/Posts.svelte"
<script lang="ts">
  import { createQuery } from "@supatype/svelte"

  const { data: posts, loading } = createQuery("post", { columns: "id, title", limit: 20 })
</script>

{#if $loading}
  <p>Loading</p>
{:else}
  <ul>{#each $posts ?? [] as post (post.id)}<li>{post.title}</li>{/each}</ul>
{/if}
```

`createQuery` fetches as soon as it is created and returns readable stores plus `refetch`. `createMutation` and `createFunction` work like the Vue versions.

<h2 id="solid">Solid</h2>

Provide the client with `SupatypeContext.Provider`. Results are accessors, so call them to read.

```tsx title="src/App.tsx"
import { For, Show } from "solid-js"
import { SupatypeContext, createQuery } from "@supatype/solid"
import { supatype } from "./supatype"

function Posts() {
  const { data: posts, loading } = createQuery("post", { columns: "id, title", limit: 20 })
  return (
    <Show when={!loading()} fallback={<p>Loading</p>}>
      <ul><For each={posts() ?? []}>{(post) => <li>{post.title}</li>}</For></ul>
    </Show>
  )
}

export function App() {
  return <SupatypeContext.Provider value={supatype}><Posts /></SupatypeContext.Provider>
}
```

The query runs on mount. `createMutation` and `createFunction` work like the Vue versions.

### How Vue, Svelte and Solid differ from React

- The query option is `columns`, not `select`. `refetchInterval`, `cache` and `draft` are React only.
- `mutate` takes `filter` but not `publish`.
- `invoke` takes a body only, so the call is always a `POST`.
- `signIn` and `signUp` take `(email, password)` rather than an object, `signInWithOAuth(provider)` sends the browser to the provider, and there is a `resetPassword(email)`.
- There is no live preview hook or rich text component.

All four bindings run the query again when a different user signs in or out.

<h2 id="react-native">React Native</h2>

`createNativeClient` is `createClient` with session storage that survives app restarts. Pass `expo-secure-store` (recommended) or AsyncStorage; without either it throws. Use the `EXPO_PUBLIC_` values `supatype keys` writes.

```ts title="src/supatype.ts"
import * as SecureStore from "expo-secure-store"
import * as Linking from "expo-linking"
import { createNativeClient, createAuthUrlListener } from "@supatype/react-native"

export const supatype = createNativeClient({
  url: process.env.EXPO_PUBLIC_SUPATYPE_URL!,
  anonKey: process.env.EXPO_PUBLIC_SUPATYPE_ANON_KEY!,
  secureStore: SecureStore,
})

// Finish sign-ins that come back through a deep link, on cold and warm start.
export const stopAuthLinks = createAuthUrlListener(supatype, { linking: Linking, pathIncludes: "auth/callback" })
```

Wrap the app in `SupatypeProvider` from `@supatype/react` and use the same hooks as on the web. The native client does not read sessions from a URL by itself, which is why the listener is there.

`openOAuth(client, { provider, redirectTo, webBrowser })` runs an OAuth sign-in in `expo-web-browser` with PKCE and returns the session, or `cancelled: true` when the user closes the browser. The ready-made native screens are on [Auth: Pre-built UI](/docs/auth.html#ui).

<h2 id="nextjs">Next.js server code</h2>

In the browser the client copies the session into a cookie named `st-auth-token` (path `/`, `SameSite=Lax`, `Secure` on HTTPS). `createServerClient` from `@supatype/ssr` reads that cookie on the server and builds a client signed in as the same user. Use it in Server Components, Route Handlers and middleware.

```ts title="src/supatype-server.ts"
import { cookies } from "next/headers"
import { createServerClient } from "@supatype/ssr"

export async function serverClient() {
  const store = await cookies()
  return createServerClient(process.env.PUBLIC_SUPATYPE_URL!, process.env.PUBLIC_SUPATYPE_ANON_KEY!, {
    cookies: { getAll: () => store.getAll(), setAll: () => {} },
  })
}
```

```tsx title="app/posts/page.tsx"
import { RichText } from "@supatype/react"
import { serverClient } from "@/supatype-server"

export default async function Page() {
  const supatype = await serverClient()
  const { data: posts } = await supatype.from("post").select("id, title, body")
  return posts?.map((post) => <RichText key={post.id} content={post.body} as="article" />)
}
```

A Route Handler uses `serverClient()` the same way. In middleware, read the cookies from the request and check the user with the auth server:

```ts title="middleware.ts"
import { NextResponse, type NextRequest } from "next/server"
import { createServerClient } from "@supatype/ssr"

export async function middleware(request: NextRequest) {
  const supatype = createServerClient(process.env.PUBLIC_SUPATYPE_URL!, process.env.PUBLIC_SUPATYPE_ANON_KEY!, {
    cookies: { getAll: () => request.cookies.getAll(), setAll: () => {} },
  })
  const { data } = await supatype.auth.getUser()
  if (!data.user) return NextResponse.redirect(new URL("/sign-in", request.url))
  return NextResponse.next()
}

export const config = { matcher: ["/account/:path*"] }
```

What the cookie handling does and does not do:

- It only reads. The `cookies` option needs both `getAll` and `setAll`, but `createServerClient` never calls `setAll`, so a no-op is fine. The browser client keeps the cookie fresh.
- A cookie whose access token has expired is ignored, and the server client runs as an anonymous caller. A page rendered after a long idle shows the signed-out view until the browser refreshes the session.
- The cookie is decoded, not verified. Queries made with it are checked by the API, so access rules hold. But do not trust `auth.getSession()` on the server to decide who someone is: call `auth.getUser()`, which asks the auth server, as the middleware above does.
- Decoding the cookie uses Node's `Buffer`. Where `Buffer` is missing, every cookie reads as expired, so run middleware on the Node.js runtime.
- Set `cookiePrefix` on both sides if you change the client's `auth.cookiePrefix`. The default is `st`.
- The server client is built from `@supatype/client`, not your generated client file, so `update(..., { publish: true })` is not accepted on it.

The browser half of a Next.js app needs the URL and anon key in `NEXT_PUBLIC_` variables. `supatype keys` does not write those names, so copy the values across. Server code can read `PUBLIC_SUPATYPE_URL` and `PUBLIC_SUPATYPE_ANON_KEY` directly.
