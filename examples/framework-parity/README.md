# Framework parity

The same screen in Vue, Svelte and Solid, against one schema and one stack.

Three of the four framework bindings had no example at all. That is a bad place for a binding to
be: it compiles, it ships, and the first person to find out whether it works is a user. This is the
example that runs them.

**The diff between the three apps is the documentation.** They do the same five things — sign in,
list tasks, add one, watch somebody else's insert arrive, call an edge function — so what remains
when you compare `src/vue/App.vue` with `src/svelte/App.svelte` and `src/solid/App.tsx` is the
idiom and nothing else. Where it turns out to be more than the idiom, that is a finding.

## Running it

```bash
pnpm install
pnpm keys              # writes ANON_KEY / VITE_SUPATYPE_ANON_KEY into .env
pnpm dev               # Postgres, the schema, the stack

pnpm dev:vue           # in another terminal — or dev:svelte, dev:solid
```

To have Supatype serve a build instead, `pnpm build:vue && pnpm mode:vue`, then reopen the gateway
root. `app.mode` is one setting, so the three take turns; each `build:*` writes to its own
`dist/<framework>` and each `mode:*` points the server at one of them.

## How the three differ

| | Vue | Svelte | Solid |
|---|---|---|---|
| Client goes in via | `app.use(supatypePlugin, client)` | `setSupatypeClient(client)` in the root component | `<SupatypeContext.Provider value={client}>` |
| Reactive values are | `Ref` — `.value` | `Readable` — `$store` | `Accessor` — `store()` |
| Reacting to a change | `watch(live, …)` | `$effect(() => { $live; … })` | `createEffect(() => { live(); … })` |

Everything else lines up: `useQuery`/`createQuery`, `useMutation`/`createMutation`,
`useAuth`/`createAuth`, `useSubscription`/`createSubscription`, `useFunction`/`createFunction` take
the same arguments and return the same fields.

## What building this turned up

Three things, none of which a typecheck of the packages alone would have found:

1. **The subscription primitive is not the same as React's.** These three take the table and
   accumulate rows into their own `data`; `@supatype/react` takes a channel name and hands you a
   callback, returning only a status. Same feature, two APIs. Worth reconciling, and worth knowing
   about before you port a component between them.
2. **`setSupatypeClient` rejected a typed client.** It took a bare `SupatypeClient`, which defaults
   to `AugmentedDatabase`, so passing `createClient<Database>(…)` — the client every real project
   builds — was a type error at the one call every Svelte app makes. Now generic, like its getter.
3. **Solid's context had the same problem**, and is now widened the way `@supatype/react`'s already
   was: a provider is one value for many consumers and cannot be generic, so the alternative was a
   cast at every `<Provider>`.
