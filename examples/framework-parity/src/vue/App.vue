<script setup lang="ts">
import { ref, watch } from "vue"
import { useAuth, useFunction, useMutation, useQuery, useSubscription } from "@supatype/vue"
import type { Database } from "../../supatype/generated/database"

type Task = Database["public"]["Tables"]["task"]["Row"]

const { user, loading: authLoading, signIn, signUp, signOut } = useAuth()
const email = ref("")
const password = ref("")
const title = ref("")
const authError = ref<string | null>(null)

const { data: tasks, refetch } = useQuery<Database, "task", Task>("task", {
  order: { column: "created_at", ascending: false },
})
const { mutate, loading: saving } = useMutation<Database, "task", Task>("task", "insert")
const ping = useFunction<{ ok: boolean }>("ping")

// Note the shape: these bindings take the table and accumulate rows into `data` themselves, where
// `@supatype/react` takes a channel name and hands you a callback. Same feature, different API —
// which is the sort of thing this example exists to make visible.
//
// So "somebody else inserted a row" is a change to `live`, and each framework watches it its own
// way: `watch` here, `$effect` in Svelte, `createEffect` in Solid.
const { data: live, status } = useSubscription<Database, "task", Task>("task", { event: "INSERT" })
watch(live, () => void refetch())

async function submitAuth(mode: "in" | "up"): Promise<void> {
  const fn = mode === "in" ? signIn : signUp
  const { error } = await fn(email.value, password.value)
  authError.value = error?.message ?? null
}

async function addTask(): Promise<void> {
  if (title.value.trim() === "") return
  await mutate({ title: title.value.trim(), done: false })
  title.value = ""
  await refetch()
}
</script>

<template>
  <main class="shell">
    <h1>Parity — Vue</h1>

    <p v-if="authLoading" class="muted">Loading session…</p>

    <section v-else-if="!user" class="card">
      <input v-model="email" placeholder="email" autocomplete="username" />
      <input v-model="password" type="password" placeholder="password" autocomplete="current-password" />
      <div class="row">
        <button @click="submitAuth('up')">Sign up</button>
        <button @click="submitAuth('in')">Sign in</button>
      </div>
      <p v-if="authError" class="error">{{ authError }}</p>
    </section>

    <section v-else>
      <p class="muted">
        {{ user.email }} · socket {{ status }}
        <button class="link" @click="signOut()">sign out</button>
      </p>

      <div class="row">
        <input v-model="title" placeholder="What needs doing?" @keyup.enter="addTask" />
        <button :disabled="saving" @click="addTask">Add</button>
      </div>

      <ul class="list">
        <li v-for="task in tasks ?? []" :key="task.id">{{ task.title }}</li>
      </ul>

      <button class="link" @click="ping.invoke()">call ping</button>
      <span v-if="ping.data.value" class="muted"> → {{ JSON.stringify(ping.data.value) }}</span>
    </section>
  </main>
</template>
