<script lang="ts">
  import { setSupatypeClient, createAuth, createFunction, createMutation, createQuery, createSubscription } from "@supatype/svelte"
  import { supatype } from "../client.js"
  import type { Database } from "../../supatype/generated/database"

  type Task = Database["public"]["Tables"]["task"]["Row"]

  // Context is set here, in the root component, which is why there is no plugin step in main.ts.
  setSupatypeClient(supatype)

  const { user, loading: authLoading, signIn, signUp, signOut } = createAuth()
  const { data: tasks, refetch } = createQuery<Database, "task", Task>("task", {
    order: { column: "created_at", ascending: false },
  })
  const { mutate, loading: saving } = createMutation<Database, "task", Task>("task", "insert")
  // Each field is its own store, so they are destructured rather than read off an object.
  const { invoke: callPing, data: pingData } = createFunction<{ ok: boolean }>("ping")

  // These bindings take the table and accumulate rows into `data` themselves, where
  // `@supatype/react` takes a channel name and a callback. Same feature, different API.
  const { data: live, status } = createSubscription<Database, "task", Task>("task", { event: "INSERT" })
  $effect(() => {
    $live
    void refetch()
  })

  let email = $state("")
  let password = $state("")
  let title = $state("")
  let authError = $state<string | null>(null)

  async function submitAuth(mode: "in" | "up"): Promise<void> {
    const fn = mode === "in" ? signIn : signUp
    const { error } = await fn(email, password)
    authError = error?.message ?? null
  }

  async function addTask(): Promise<void> {
    if (title.trim() === "") return
    await mutate({ title: title.trim(), done: false })
    title = ""
    await refetch()
  }
</script>

<main class="shell">
  <h1>Parity — Svelte</h1>

  {#if $authLoading}
    <p class="muted">Loading session…</p>
  {:else if !$user}
    <section class="card">
      <input bind:value={email} placeholder="email" autocomplete="username" />
      <input bind:value={password} type="password" placeholder="password" autocomplete="current-password" />
      <div class="row">
        <button onclick={() => submitAuth("up")}>Sign up</button>
        <button onclick={() => submitAuth("in")}>Sign in</button>
      </div>
      {#if authError}<p class="error">{authError}</p>{/if}
    </section>
  {:else}
    <section>
      <p class="muted">
        {$user.email} · socket {$status}
        <button class="link" onclick={() => signOut()}>sign out</button>
      </p>

      <div class="row">
        <input bind:value={title} placeholder="What needs doing?" />
        <button disabled={$saving} onclick={addTask}>Add</button>
      </div>

      <ul class="list">
        {#each $tasks ?? [] as task (task.id)}
          <li>{task.title}</li>
        {/each}
      </ul>

      <button class="link" onclick={() => callPing()}>call ping</button>
      {#if $pingData}<span class="muted"> → {JSON.stringify($pingData)}</span>{/if}
    </section>
  {/if}
</main>
