# Realtime

A change in the database arriving at a subscriber.

Realtime is on by default, so every other example already runs the service. None
of them subscribed to anything, which meant the only thing ever proven was that
the gateway would upgrade a WebSocket. **A socket that opens and never delivers a
row looks exactly like a working one** until somebody waits for a message that
does not come.

So this example waits, with a deadline, and exits non-zero when nothing arrives.

## Running it

Running this outside the repo? See [Running an example](../README.md#running-an-example).

From the monorepo root:

```sh
pnpm install
pnpm build     # the CLI and the libraries run from their dist/
```

Then, from this directory:

```sh
pnpm dev       # in one terminal: Postgres, the schema, the stack
pnpm verify    # in another
```

`verify` subscribes to `public:message`, writes a row over REST, and asserts the
`INSERT` reaches the subscriber:

```
  subscribed to public:message
  inserted a row over REST
  received the INSERT: hello at 2026-08-31T06:02:58.573Z
PASS: a write reached the subscriber
```

Stop the realtime container and run it again to see it fail, which is the point:

```
FAIL: the channel never subscribed (last status: never reported)
```

## The one thing worth copying

`client.from("message").subscribe(cb)` registers the listener and joins the
channel. Calling `.subscribe()` on the returned channel does not join again; it
is how you watch the status:

```ts
const sub = supatype.from("message").subscribe(onChange, { event: "INSERT" })
sub.channel.subscribe((status) => { /* SUBSCRIBED, CHANNEL_ERROR, ... */ })
```

Wait for `SUBSCRIBED` before writing the row you expect to be told about, or
the write races the subscription and the event is missed for a reason that has
nothing to do with realtime.

## Broadcast and presence

```sh
pnpm verify:channels
```

The other two channel features, asserted between **two** clients, because one
that only works when sender and receiver share a connection is not a feature
anyone can use:

```
  ok   broadcast reached the other client: {"from":"sender","at":1788159108931}
  ok   presence join seen by the other client: [{"user_id":"anonymous","who":"sender"}]
PASS: broadcast and presence both delivered between two clients
```

Neither touches the database, so they are checked separately from
`postgres_changes`: a stack whose replication is broken still serves them, and a
stack whose socket is fine can still fail them.

## Filtered subscriptions

```sh
pnpm verify:filter
```

A subscription with a filter must be told about the rows it asked for and not
the others. An unfiltered run cannot catch a filter dropped on the way to the
server, because receiving every row still includes the one you were watching
for. So this asserts both halves: it subscribes
with `filter: "author=eq.wanted-author"`, writes a row that does not match and
then one that does, and fails if the first arrives or the second does not:

```
  subscribed with filter author=eq.wanted-author
  the matching row arrived
  the non-matching row did not arrive (seen: ["wanted-author"])
PASS: the filter was applied on both sides
```

## What it does not cover

Change events for a user whose access rules hide the row. Everything here is
public, so the absence of an event would be ambiguous; access control has its
own examples.
