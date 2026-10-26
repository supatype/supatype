/**
 * What a project with PostGIS and pgvector columns gets from the API once its extensions live in
 * `extensions` rather than `public`.
 *
 * The columns still read, write and filter through REST and GraphQL: their types and operators
 * resolve through PostgREST's extra search path, which carries `extensions` on every tier. The raw
 * extension functions are no longer API endpoints: PostGIS and pgvector put about 940 functions in
 * `public`, a third of them served as `/rest/v1/rpc/*`, which is what made the OpenAPI root slow
 * enough to time out after a push.
 *
 * Run by extension-schema-e2e.sh against a stack it pushed `schema.ts` to.
 */
import { at, isRecord, isRecordArray } from "../lib/json.js"

const BASE = process.env["SUPATYPE_URL"] ?? "http://127.0.0.1:18473"
const ANON = process.env["ANON_KEY"] ?? ""
if (!ANON) throw new Error("ANON_KEY must be set")

let failures = 0
const ok = (m: string): void => console.log(`  ok   ${m}`)
const bad = (m: string, detail = ""): void => {
  failures++
  console.error(`  FAIL ${m}${detail ? ` - ${detail}` : ""}`)
}
const check = (cond: boolean, m: string, detail = ""): void => (cond ? ok(m) : bad(m, detail))

interface Sent {
  status: number
  text: string
  json: unknown
}

interface Request {
  method?: string
  body?: unknown
  headers?: Record<string, string>
}

async function send(path: string, request: Request = {}): Promise<Sent> {
  const headers: Record<string, string> = { apikey: ANON, Authorization: `Bearer ${ANON}`, ...request.headers }
  if (request.body !== undefined) headers["Content-Type"] = "application/json"
  const res = await fetch(`${BASE}${path}`, {
    method: request.method ?? "GET",
    headers,
    ...(request.body !== undefined && { body: JSON.stringify(request.body) }),
  })
  const text = await res.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    /* not JSON: kept as text */
  }
  return { status: res.status, text, json }
}

type Row = Record<string, unknown>

function rowsOf(sent: Sent): Row[] {
  return isRecordArray(sent.json) ? sent.json : []
}

const LONDON = "SRID=4326;POINT(-0.1276 51.5072)"
const PARIS = "SRID=4326;POINT(2.3522 48.8566)"
const BERLIN = "SRID=4326;POINT(13.405 52.52)"

/** The rows `select` reads back after filtering one column with `eq`. */
async function filtered(column: string, value: string): Promise<Row[]> {
  const sent = await send(`/rest/v1/place?select=name&${column}=eq.${encodeURIComponent(value)}`)
  if (sent.status !== 200) bad(`filter on ${column}`, `${sent.status} ${sent.text.slice(0, 200)}`)
  return rowsOf(sent)
}

async function restRoundTrip(): Promise<Row | undefined> {
  const written = await send("/rest/v1/place", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: [
      { name: "london", location: LONDON, area: LONDON, embedding: "[1,2,3]" },
      { name: "paris", location: PARIS, area: PARIS, embedding: "[3,2,1]" },
    ],
  })
  check(written.status === 201, "REST writes Geo, GeoPoint and Vector columns", `${written.status} ${written.text.slice(0, 300)}`)
  const read = await send("/rest/v1/place?select=name,location,area,embedding&name=eq.london")
  const row = rowsOf(read)[0]
  check(read.status === 200 && row !== undefined, "REST reads them back", `${read.status} ${read.text.slice(0, 300)}`)
  check(row?.["embedding"] === "[1,2,3]", "the vector reads back as written", JSON.stringify(row?.["embedding"]))
  check(typeof row?.["location"] === "string" && row["location"] === row["area"], "the points read back alike", JSON.stringify(row))
  const byVector = await filtered("embedding", "[1,2,3]")
  check(byVector.length === 1 && byVector[0]?.["name"] === "london", "REST filters on a vector column", JSON.stringify(byVector))
  const byPoint = await filtered("location", PARIS)
  check(byPoint.length === 1 && byPoint[0]?.["name"] === "paris", "REST filters on a geography column", JSON.stringify(byPoint))
  return row
}

async function gql(query: string): Promise<{ status: number; data: Row | null; errors: string[] }> {
  const sent = await send("/graphql/v1", { method: "POST", body: { query } })
  const data = at(sent.json, "data")
  const errors = at(sent.json, "errors")
  return {
    status: sent.status,
    data: isRecord(data) ? data : null,
    errors: Array.isArray(errors) ? errors.map((e) => String(at(e, "message"))) : [],
  }
}

function nodes(data: Row | null): Row[] {
  const edges = at(data?.["placeCollection"], "edges")
  return Array.isArray(edges) ? edges.map((e) => at(e, "node")).filter(isRecord) : []
}

async function graphqlRoundTrip(rest: Row | undefined): Promise<void> {
  const read = await gql('{ placeCollection(filter: {name: {eq: "london"}}) { edges { node { name location area embedding } } } }')
  const node = nodes(read.data)[0]
  check(read.errors.length === 0 && node !== undefined, "GraphQL reflects and reads the Geo, GeoPoint and Vector columns", JSON.stringify(read))
  check(
    node?.["location"] === rest?.["location"] && node?.["embedding"] === rest?.["embedding"],
    "GraphQL reads the values REST reads",
    JSON.stringify({ node, rest }),
  )
  // pg_graphql names the mutation after the table as it is, `place`, with no inflection.
  const written = await gql(
    `mutation { insertIntoplaceCollection(objects: [{name: "berlin", location: "${BERLIN}", embedding: "[0,1,0]"}]) { affectedCount } }`,
  )
  check(written.errors.length === 0, "GraphQL writes them", JSON.stringify(written))
  const named = async (filter: string): Promise<string> => {
    const found = await gql(`{ placeCollection(filter: ${filter}) { edges { node { name } } } }`)
    return found.errors.length > 0 ? found.errors.join("; ") : nodes(found.data).map((n) => n["name"]).join()
  }
  const byVector = await named('{embedding: {eq: "[0,1,0]"}}')
  check(byVector === "berlin", "GraphQL filters on a vector column", byVector)
  const byPoint = await named(`{location: {eq: "${String(rest?.["location"])}"}}`)
  check(byPoint === "london", "GraphQL filters on a geography column", byPoint)
}

async function noExtensionEndpoints(): Promise<void> {
  const called = await send("/rest/v1/rpc/st_distance", { method: "POST", body: { geog1: LONDON, geog2: PARIS } })
  check(called.status === 404, "/rest/v1/rpc/st_distance is not an endpoint", `${called.status} ${called.text.slice(0, 200)}`)
  const root = await send("/rest/v1/")
  const paths = Object.keys(((root.json ?? {}) as { paths?: Row }).paths ?? {})
  const rpc = paths.filter((p) => p.startsWith("/rpc/"))
  const extension = rpc.filter((p) => /^\/rpc\/(st_|postgis_|vector_|l2_|cosine_|unaccent|gen_random|digest|crypt)/.test(p))
  check(root.status === 200 && extension.length === 0, "the OpenAPI root lists no PostGIS, pgvector or unaccent function", extension.slice(0, 10).join(", "))
  check(
    root.status === 200 && root.text.length < 100_000,
    `the OpenAPI root is small (HTTP ${root.status}, ${root.text.length} bytes, ${rpc.length} RPC paths)`,
  )
}

async function main(): Promise<void> {
  console.log("==> REST")
  const row = await restRoundTrip()
  console.log("==> GraphQL")
  await graphqlRoundTrip(row)
  console.log("==> No extension function is an endpoint")
  await noExtensionEndpoints()
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`)
    process.exit(1)
  }
  console.log("\nPASS: Geo, GeoPoint and Vector work through REST and GraphQL, and no extension function is an endpoint")
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
