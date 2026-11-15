# @supatype/client

The typed Supatype client: REST, auth, storage and realtime. The full guide is on the docs site.
This page covers private realtime channels only.

## Private channels

A channel is private when your schema declares it (`Channel<"lot:{id}", { ... }>`). The realtime
server enforces every declaration for every client, whether or not the client says anything. The
client option is an assertion on top of that:

```ts
const lot = client.realtime.channel(`lot:${id}`, { private: true })

lot
  .onBroadcast("bid", (payload) => addBid(payload))
  .subscribe((status, err) => {
    if (status === "CHANNEL_ERROR" && err instanceof RealtimeChannelError) {
      // err.reason says why, err.channel says which
    }
  })
```

`private: true` changes two outcomes, both in your favour:

- If no declaration matches the name, the join is refused (`reason: "not_declared"`). A typo in a
  channel name fails at once instead of quietly opening a channel nobody guards.
- If the server does not announce private channel support, the join is never sent
  (`reason: "unsupported_server"`: "this realtime server does not enforce private channels; upgrade
  it"). An older server would ignore the flag and admit an open channel.

Both arrive as `CHANNEL_ERROR` on the status callback, with a `RealtimeChannelError` as the second
argument. Its `reason` is one of:

| reason | meaning |
| --- | --- |
| `unsupported_server` | the server does not enforce private channels; nothing was sent |
| `join_denied` | a declaration matched and its `join` rule denied this user |
| `not_declared` | `private: true` was set and no declaration matches the name |
| `does_not_fit` | a declaration matches but the parameters do not fit (`lot:abc` for `lot:{id}`) |
| `unavailable` | the server could not reach the database; `err.retryable` is `true` |
| `shared_instance` | the server is a shared instance, where private channels are not available |
| `withdrawn` | a channel you held was taken away |
| `refused` | any other refusal; `err.message` has the server's words |

### Access withdrawn

The server judges a held channel again whenever the token changes, every few minutes, and when the
rules behind it change. A user who no longer passes the `join` rule is removed: every handle on the
channel gets `CHANNEL_ERROR` with `reason: "withdrawn"`, and the client does not join again on its
own, since the server would refuse again. Subscribe again to try the join once more.

### Receiving messages sent from the database

A function in the database can broadcast to a channel with `_supatype.realtime_send`:

```sql
SELECT _supatype.realtime_send('lot:' || lot_id::text, 'bid', jsonb_build_object('amount', new_amount));
```

It reaches every member the channel's `join` rule admitted, and nobody else. The client receives it
exactly as it receives a broadcast from another client, with no sender:

```ts
client.realtime.channel(`lot:${id}`, { private: true }).onBroadcast("bid", ({ amount }) => show(amount)).subscribe()
```

The `send` rule of the channel applies to the caller of `realtime_send`: a caller who may not
broadcast on the channel gets error `42501`, so call it from an RPC function the right users can run.
