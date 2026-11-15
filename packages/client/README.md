# @supatype/client

The typed Supatype client: REST, auth, storage and realtime. The full guide, including private
channels, is on the docs site: https://www.supatype.com/docs/realtime.html

## Private channels

A channel is private when your schema declares it. The server enforces every declaration for every
client; `private: true` asserts it, so a name no declaration matches is refused and a server that
cannot enforce it is never asked.

```ts
client.realtime.channel(`lot:${id}`, { private: true }).onBroadcast("bid", show).subscribe()
```

A refusal arrives as `CHANNEL_ERROR` with a `RealtimeChannelError` (`reason`, `channel`). A function in
the database can broadcast to the channel with `_supatype.realtime_send`; the client receives it like
any other broadcast. See the docs page for the reasons and the rules.
