# Field validation, end to end

Three ways to say "this value is not allowed", and the point of this example is that they are
**different**, not interchangeable.

| | Mechanism | Where it holds | Declared as |
|---|---|---|---|
| 1 | **Bounds** on a field's type | every writer, including `psql` and seeds | `MaxLength<string, 80>` |
| 2 | **Constraints** on the model | every writer | `constraints: [Lte<"a", "b">]` |
| 3 | **Validators**, an edge function per field | the API write path only | `validate: { field: "fn-name" }` |

The first two compile to Postgres `CHECK` constraints. The third runs your TypeScript before the
write, and is the only one whose refusal can name a field back to the caller.

**Anything expressible as 1 or 2 should be.** A validator is bypassed by direct SQL, so a rule that
matters is a `CHECK`, not a function. Use a validator for what a `CHECK` genuinely cannot say.

## Run it

```bash
pnpm install
pnpm keys              # writes ANON_KEY / SERVICE_ROLE_KEY into .env
pnpm dev
```

Studio is at `http://127.0.0.1:18473/studio/`. Open **Product → Rules** to see every bound,
constraint and index this schema declares, read from the config the engine produced rather than from
the schema file, so it shows what the database is actually enforcing.

Create an admin user first:

```bash
npx supatype admin create-user --email you@example.com --password <password> --role admin
```

If `localhost` misbehaves, use `127.0.0.1`. Docker Desktop sometimes leaves a broken IPv6 forwarder
on the gateway port, and Chrome resolves `localhost` to `::1` first.

## What to try

Every one of these is refused, and the error tells you which rule bit:

```bash
API=http://127.0.0.1:18473/rest/v1/product
# sign in first; `create` is LoggedIn, not Public
TOKEN=$(curl -s -X POST "http://127.0.0.1:18473/auth/v1/token?grant_type=password" \
  -H "apikey: $ANON_KEY" -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"<password>"}' | jq -r .access_token)

post() { curl -s -X POST "$API" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -H "Prefer: return=minimal" -d "$1"; }

# 1. bounds
post '{"name":"ab","status":"draft"}'                          # MinLength<3>
post '{"name":"Widget","status":"draft","rating":9}'           # Between<Int,1,5>

# localized: only the `fr` value breaches, and that is the case a scalar check cannot see
post '{"name":"W1","status":"draft","headline":{"en":"fine","fr":"beaucoup trop long pour tenir dans la limite de soixante caracteres imposee"}}'

# 2. constraints
post '{"name":"W2","status":"published"}'                      # published needs a sku
post '{"name":"W3","status":"draft","sku":"nope"}'             # Matches<"^[A-Z]{3}-[0-9]{4}$">

# 3. validator: total setup minutes, which is a rule about the contents of a JSON array
post '{"name":"W4","status":"draft","setupItems":[{"label":"prep","minutes":90},{"label":"build","minutes":80}]}'
```

The last one answers `422` with `{"field":"setupItems","message":"..."}`. That `field` is what lets
Studio put the message on the right input instead of at the top of the form.

## Running against a local build

`supatype.local.config.ts.example` points the CLI at engine, server and Studio built from your
working tree rather than a published release. Copy it, edit the paths, and `pnpm dev` picks it up:

```bash
cp supatype.local.config.ts.example supatype.local.config.ts
```

It is gitignored, so your paths stay yours.

Note the file name: the CLI looks for **`supatype.local.config.ts`**, not `supatype.config.local.ts`.
