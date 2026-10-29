---
title: "Realtime"
description: "Supatype realtime: subscribe to table changes that respect read access and field rules, filters, broadcast and presence, React and Vue hooks, config and limits."
---

Subscribe to inserts, updates and deletes on your tables over a WebSocket. Each change is checked against the subscriber's read access before it is sent.

Pre-1.0: APIs and config may change between releases.

<h2 id="changes">What is sent</h2>

The realtime service reads changes from Postgres logical replication, so every committed `INSERT`, `UPDATE` and `DELETE` is seen, whether it came from the API, Studio, a function or plain SQL. There is nothing to switch on per table. A change is only sent to clients subscribed to that table.

| Event | `new` | `old` |
| --- | --- | --- |
| `INSERT` | the whole row | `null` |
| `UPDATE` | the whole row | the primary key only |
| `DELETE` | `null` | the primary key only |

`old` is typed as a row, but it holds only the key columns. Use it to find the row you already have, not to read the previous values.

Values arrive with the same types as a REST read. A `BigInt` column becomes a native `bigint`, and `Decimal` and `Money` stay exact strings.

<h2 id="access">Read access</h2>

Realtime follows the same [access rules](/docs/schema.html#access) as the REST API. For each change and each subscriber, the service checks with the subscriber's token, inside Postgres:

- Insert and update: the row is selected again, by its `id` column, as the subscriber. If the `read` rule hides it, the change is not sent. The check sees the row as it is at that moment, so a row deleted straight after it was inserted is not sent either.
- Field rules: a column the subscriber may not read under a [field rule](/docs/schema.html#field-rules) arrives as `null`, in both `new` and `old`. A filter on such a column is matched against the masked value, so it cannot be used to test a hidden value.
- Service role: sees every change unmasked.
- No token: receives no changes.

:::caution
Deletes are checked more loosely. The row is gone, so there is nothing to select. A subscriber receives every delete on a table their role may read at all, even deletes of rows their `read` rule would hide. Field masking still applies, and `old` holds only the primary key, so what this reveals is the key of each deleted row. If that matters, do not use a guessable key, or do not subscribe untrusted users to deletes on that table.
:::

The row check looks for a column called `id`. On a table without one it uses the first column of the row.

<h2 id="subscribe">Subscribe</h2>

`from(table).subscribe()` is the shortest path, shown on the [client page](/docs/client.html#realtime). The callback's rows are typed from your schema.

```ts
const sub = supatype.from("comment").subscribe(
  (change) => {
    if (change.eventType === "INSERT") addComment(change.new)
    if (change.eventType === "UPDATE") replaceComment(change.new)
    if (change.eventType === "DELETE") removeComment(change.old?.id)
  },
  { event: "*", filter: `post_id=eq.${postId}` },
)

// later
sub.unsubscribe()
```

Each call opens its own channel, so two components watching the same table do not interfere. All channels share one WebSocket per client. The payload has `eventType`, `new`, `old`, `schema`, `table` and `commitTimestamp`.

### Options

| Option | Values | Default |
| --- | --- | --- |
| `event` | `"INSERT"`, `"UPDATE"`, `"DELETE"`, `"*"` | `"*"` |
| `filter` | `"column=op.value"`, several joined with commas | none |
| `schema` | the Postgres schema of the table | `"public"` |

### Filters

A filter is checked on the server, so changes that do not match never reach the client. Several conditions joined with commas must all match. The operators are `eq`, `neq`, `gt`, `gte`, `lt` and `lte`.

- Values are compared as text. `eq` and `neq` behave as you expect. `gt` and `lt` on numbers do not: `"10"` sorts before `"9"`.
- An operator not in that list is ignored, and the filter then matches every change.
- A delete is matched on `old`, which holds only the primary key. A filter on any other column matches no deletes.

### Channels

`supatype.realtime.channel(name)` is the lower-level form, for when you want the channel's status or want to mix changes with [broadcast and presence](#broadcast):

```ts
const channel = supatype.realtime
  .channel(`post:${postId}`)
  .on("postgres_changes", { event: "INSERT", table: "comment", filter: `post_id=eq.${postId}` }, (change) => {
    showComment(change.new)
  })
  .subscribe((status) => console.log(status))
```

Status is `SUBSCRIBING`, `SUBSCRIBED`, `CHANNEL_ERROR`, `TIMED_OUT` or `CLOSED`. Pass `table` explicitly. Without it the channel name is read as `schema:table`.

A channel carries one table subscription. If you call `.on("postgres_changes", ...)` more than once on a channel, the first call's table, event and filter are what the server registers. Use one channel per table.

<h2 id="broadcast">Broadcast and presence</h2>

Broadcast sends a message to everyone else on a channel. Presence tells a channel who has joined and left. Neither touches the database.

```ts
const room = supatype.realtime
  .channel(`cursor:${docId}`)
  .onBroadcast("move", (payload) => drawCursor(payload))
  .onPresence(({ joins, leaves }) => updateUsers(joins, leaves))
  .subscribe((status) => {
    if (status === "SUBSCRIBED") room.track({ name: displayName })
  })

room.broadcast("move", { x: 120, y: 48 })
```

- Only clients that have subscribed to the channel receive its messages. The sender does not get its own broadcast back.
- A presence entry is the payload you pass to `track`, plus `user_id` from the token.
- A client that joins late hears about joins and leaves from then on. It is not sent the list of who is already there.
- A client leaves on `untrack()`, on unsubscribe and when its socket closes.
- Messages sent while the socket is not open are dropped, so send after `SUBSCRIBED`.

:::caution
Broadcast and presence have no access rules. Anyone with your anon key who knows a channel's name can join it, read its messages and send to it. Do not put private data in a broadcast, and use a hard-to-guess channel name for anything you would not show the public.
:::

<h2 id="hooks">Framework hooks</h2>

`@supatype/react` exports `useSubscription`. It subscribes when the component mounts, unsubscribes when it unmounts, and re-subscribes when the channel name, event, table, schema or filter changes. The callback can change between renders without re-subscribing.

```tsx
import { useSubscription } from "@supatype/react"

function Comments({ postId }: { postId: string }) {
  const { status } = useSubscription(`comments:${postId}`, {
    table: "comment",
    event: "INSERT",
    filter: `post_id=eq.${postId}`,
    callback: (change) => addComment(change.new),
  })
  return <p>{status}</p>
}
```

It needs `SupatypeProvider` above it, which takes your client as `client`. Give each use its own channel name: two hooks with the same name share a channel.

`@supatype/vue` has `useSubscription(table, { event, filter })`, and `@supatype/svelte` and `@supatype/solid` have `createSubscription(table, { event, filter })`. These watch the `public` schema and return `data`, `error` and `status`. `data` starts empty and collects rows from the changes that arrive: inserts are added, updates replace the row with the same `id`, deletes remove it. They do not load the rows that already exist, so pair them with a query.

<h2 id="connection">Connection and auth</h2>

The client opens the socket at `/realtime/v1` on your project URL when the first channel subscribes, and closes it when the last one unsubscribes. It sends the current session's token, or the anon key when nobody is signed in.

When someone signs in, signs out or a different user signs in, the client reconnects with the new token and joins every channel again. Access is checked as the new identity from then on. A token refresh for the same user does not reconnect, so no changes are missed.

If the socket drops, the client retries after 1, 2, 4 seconds and so on, doubling each time, for up to 10 attempts. Channels report `SUBSCRIBING` while it retries and `TIMED_OUT` once it gives up. Changes made while the socket was down are not replayed, so refetch after a reconnect if you need the gaps filled.

<h2 id="config">Config and requirements</h2>

Realtime needs Postgres with `wal_level = logical`, the `wal2json` plugin, and a database role allowed to create replication slots. The Postgres that `supatype dev` and the self-host stack run has all three. For a database you bring yourself, `supatype db check` tests for them.

If the database cannot do logical decoding, realtime does not stop the stack. The service stays up and serves broadcast and presence, change subscriptions deliver nothing, and `/health/ready` on the service answers 503 with the reason. When you run against your own database, set `database.external.realtime` to `false` in `supatype.config.ts` to leave the service out of the stack.

The service reads these environment variables. The self-host compose file sets the first three.

| Variable | Default | What it controls |
| --- | --- | --- |
| `DATABASE_URL` | required | The database to read changes from |
| `JWT_SECRET` | required | Verifies subscribers' tokens |
| `SLOT_NAME` | `supatype_realtime` | The replication slot the service creates and reads |
| `PORT` | 4000 | The port the service listens on |
| `REPLICATION_POLL_INTERVAL` | 100 | How often, in milliseconds, the slot is read |
| `SECURE_CHANNELS` | `true` | When `true`, a client must present a valid token before it can join a channel |

<h2 id="limits">Limits</h2>

- Changes are picked up by reading the replication slot every 100 ms, so expect that much delay on top of the network.
- While `supatype push` is changing the schema, the slot is not read. Changes made during the push are held in the slot and sent once it finishes.
- Each change costs one database query per subscriber, to check that subscriber's access. Many subscribers to a busy table means many queries.
- The replication slot keeps WAL until the service reads it. If the service is stopped for a long time while the database keeps writing, WAL builds up on disk.
- Subscriptions live in the service's memory. A restart drops every socket, and clients reconnect and join again.
