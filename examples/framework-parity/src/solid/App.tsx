import { createEffect, createSignal, For, Show } from "solid-js"
import { createAuth, createFunction, createMutation, createQuery, createSubscription } from "@supatype/solid"
import type { Database } from "../../supatype/generated/database"

type Task = Database["public"]["Tables"]["task"]["Row"]

export function App() {
  const { user, loading: authLoading, signIn, signUp, signOut } = createAuth()
  const { data: tasks, refetch } = createQuery<Database, "task", Task>("task", {
    order: { column: "created_at", ascending: false },
  })
  const { mutate, loading: saving } = createMutation<Database, "task", Task>("task", "insert")
  const ping = createFunction<{ ok: boolean }>("ping")

  // These bindings take the table and accumulate rows into `data` themselves, where
  // `@supatype/react` takes a channel name and a callback. Same feature, different API.
  const { data: live, status } = createSubscription<Database, "task", Task>("task", { event: "INSERT" })
  createEffect(() => {
    live()
    void refetch()
  })

  const [email, setEmail] = createSignal("")
  const [password, setPassword] = createSignal("")
  const [title, setTitle] = createSignal("")
  const [authError, setAuthError] = createSignal<string | null>(null)

  async function submitAuth(mode: "in" | "up"): Promise<void> {
    const fn = mode === "in" ? signIn : signUp
    const { error } = await fn(email(), password())
    setAuthError(error?.message ?? null)
  }

  async function addTask(): Promise<void> {
    if (title().trim() === "") return
    await mutate({ title: title().trim(), done: false })
    setTitle("")
    await refetch()
  }

  return (
    <main class="shell">
      <h1>Parity — Solid</h1>

      <Show when={!authLoading()} fallback={<p class="muted">Loading session…</p>}>
        <Show
          when={user()}
          fallback={
            <section class="card">
              <input value={email()} onInput={(e) => setEmail(e.currentTarget.value)} placeholder="email" autocomplete="username" />
              <input value={password()} onInput={(e) => setPassword(e.currentTarget.value)} type="password" placeholder="password" autocomplete="current-password" />
              <div class="row">
                <button onClick={() => void submitAuth("up")}>Sign up</button>
                <button onClick={() => void submitAuth("in")}>Sign in</button>
              </div>
              <Show when={authError()}>{(message) => <p class="error">{message()}</p>}</Show>
            </section>
          }
        >
          {(signedIn) => (
            <section>
              <p class="muted">
                {signedIn().email} · socket {status()}
                <button class="link" onClick={() => void signOut()}>sign out</button>
              </p>

              <div class="row">
                <input value={title()} onInput={(e) => setTitle(e.currentTarget.value)} placeholder="What needs doing?" />
                <button disabled={saving()} onClick={() => void addTask()}>Add</button>
              </div>

              <ul class="list">
                <For each={tasks() ?? []}>{(task) => <li>{task.title}</li>}</For>
              </ul>

              <button class="link" onClick={() => void ping.invoke()}>call ping</button>
              <Show when={ping.data()}>{(data) => <span class="muted"> → {JSON.stringify(data())}</span>}</Show>
            </section>
          )}
        </Show>
      </Show>
    </main>
  )
}
