import pg from "pg"
import { isServiceRole, type JwtPayload } from "./auth.js"
import { config } from "./env.js"
import { isPolicyViolation, isUniqueViolation } from "./pg-errors.js"

const pool = new pg.Pool({ connectionString: config.databaseUrl })

/** Close every pooled connection, so a database going away afterwards raises nothing here. */
export async function closePool(): Promise<void> {
  await pool.end()
}

// ─── Types ──────────────────────────────────────────────────────────────────────

export type BucketAccessMode = "public" | "private" | "custom"

export interface BucketRow {
  id: string
  name: string
  public: boolean
  file_size_limit: number | null
  allowed_mime_types: string[] | null
  access_mode: BucketAccessMode
  /** Optional raw S3 bucket policy JSON from schema / API. */
  s3_bucket_policy: string | null
  created_at: string
  updated_at: string
}

export interface ObjectRow {
  id: string
  bucket_id: string
  name: string
  owner: string | null
  metadata: Record<string, unknown> | null
  /** Which stored copy of the bytes is live; null for an object written before versions. */
  version: string | null
  path_tokens: string[]
  created_at: string
  updated_at: string
  last_accessed_at: string
}

// ─── Schema bootstrap ───────────────────────────────────────────────────────────

export async function ensureSchema(): Promise<void> {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS storage;

    CREATE TABLE IF NOT EXISTS storage.buckets (
      id text PRIMARY KEY,
      name text NOT NULL UNIQUE,
      public boolean NOT NULL DEFAULT false,
      file_size_limit bigint,
      allowed_mime_types text[],
      access_mode text NOT NULL DEFAULT 'private',
      s3_bucket_policy text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS storage.objects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      bucket_id text NOT NULL REFERENCES storage.buckets(id),
      name text NOT NULL,
      owner uuid,
      metadata jsonb,
      version text,
      path_tokens text[] GENERATED ALWAYS AS (string_to_array(name, '/')) STORED,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      last_accessed_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (bucket_id, name)
    );

    CREATE INDEX IF NOT EXISTS idx_objects_bucket_name ON storage.objects(bucket_id, name);

    ALTER TABLE storage.buckets ADD COLUMN IF NOT EXISTS access_mode text NOT NULL DEFAULT 'private';
    ALTER TABLE storage.buckets ADD COLUMN IF NOT EXISTS s3_bucket_policy text;
    ALTER TABLE storage.objects ADD COLUMN IF NOT EXISTS last_accessed_at timestamptz NOT NULL DEFAULT now();
    ALTER TABLE storage.objects ADD COLUMN IF NOT EXISTS version text;
  `)
}

/** Get total storage usage across all buckets in bytes. */
export async function getTotalStorageUsage(): Promise<number> {
  const res = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM((metadata->>'size')::bigint), 0) AS total FROM storage.objects`,
  )
  return parseInt(res.rows[0]?.total ?? "0", 10)
}

// ─── Bucket CRUD ────────────────────────────────────────────────────────────────

export async function createBucket(
  id: string,
  name: string,
  isPublic: boolean,
  fileSizeLimit?: number,
  allowedMimeTypes?: string[],
  accessMode?: BucketAccessMode,
  s3BucketPolicy?: string | null,
): Promise<BucketRow> {
  const mode: BucketAccessMode =
    accessMode ?? (isPublic ? "public" : "private")
  const res = await pool.query<BucketRow>(
    `INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types, access_mode, s3_bucket_policy)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      id,
      name,
      isPublic,
      fileSizeLimit ?? null,
      allowedMimeTypes ?? null,
      mode,
      s3BucketPolicy ?? null,
    ],
  )
  return res.rows[0]!
}

export async function getBucket(id: string): Promise<BucketRow | null> {
  const res = await pool.query<BucketRow>(
    `SELECT * FROM storage.buckets WHERE id = $1`,
    [id],
  )
  return res.rows[0] ?? null
}

export async function listBuckets(): Promise<BucketRow[]> {
  const res = await pool.query<BucketRow>(
    `SELECT * FROM storage.buckets ORDER BY name`,
  )
  return res.rows
}

export async function updateBucket(
  id: string,
  updates: {
    public?: boolean
    file_size_limit?: number | null
    allowed_mime_types?: string[] | null
    access_mode?: BucketAccessMode
    s3_bucket_policy?: string | null
  },
): Promise<BucketRow | null> {
  const sets: string[] = []
  const values: unknown[] = []
  let idx = 1

  if (updates.public !== undefined) {
    sets.push(`public = $${idx++}`)
    values.push(updates.public)
  }
  if (updates.file_size_limit !== undefined) {
    sets.push(`file_size_limit = $${idx++}`)
    values.push(updates.file_size_limit)
  }
  if (updates.allowed_mime_types !== undefined) {
    sets.push(`allowed_mime_types = $${idx++}`)
    values.push(updates.allowed_mime_types)
  }
  if (updates.access_mode !== undefined) {
    sets.push(`access_mode = $${idx++}`)
    values.push(updates.access_mode)
  }
  if (updates.s3_bucket_policy !== undefined) {
    sets.push(`s3_bucket_policy = $${idx++}`)
    values.push(updates.s3_bucket_policy)
  }
  if (sets.length === 0) return getBucket(id)

  sets.push(`updated_at = now()`)
  values.push(id)

  const res = await pool.query<BucketRow>(
    `UPDATE storage.buckets SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
    values,
  )
  return res.rows[0] ?? null
}

export async function deleteBucketRow(id: string): Promise<boolean> {
  const res = await pool.query(
    `DELETE FROM storage.buckets WHERE id = $1`,
    [id],
  )
  return (res.rowCount ?? 0) > 0
}

/**
 * Delete every object row in a bucket, returning what was stored so the caller can delete the bytes.
 *
 * It returned nothing, so emptying a bucket removed its rows and left every file in S3.
 */
export async function emptyBucket(id: string): Promise<StoredObject[]> {
  const res = await pool.query<StoredObject>(
    `DELETE FROM storage.objects WHERE bucket_id = $1 RETURNING name, version`,
    [id],
  )
  return res.rows
}

// ─── Object metadata ────────────────────────────────────────────────────────────

/**
 * An object's row, read with the service's own connection.
 *
 * For the checks that have to see past the caller's rules: whether an object exists at all, so a
 * missing one answers 404 rather than a 403 that would confirm nothing is there. Never for deciding
 * what a caller may do; that is `asCaller`'s job.
 */
export async function getObject(bucketId: string, name: string): Promise<ObjectRow | null> {
  const res = await pool.query<ObjectRow>(
    `SELECT * FROM storage.objects WHERE bucket_id = $1 AND name = $2`,
    [bucketId, name],
  )
  return res.rows[0] ?? null
}

/**
 * Roles a caller may act as.
 *
 * An allowlist because the value comes from a JWT claim and becomes the session's role. These are
 * the three the gateway issues.
 */
const CALLER_ROLES = new Set(["anon", "authenticated", "service_role"])

type Privilege = "SELECT" | "INSERT" | "UPDATE" | "DELETE"

/** The caller's role is not one the gateway issues, so it never reaches the database. */
export class UnknownRole extends Error {
  constructor(readonly role: string) {
    super(`${role} is not a caller role`)
    this.name = "UnknownRole"
  }
}

/** The caller's role has none of the grants on `storage.objects` its bucket rules need. */
export class MissingGrant extends Error {
  constructor(readonly role: string) {
    super(`${role} holds no grant on storage.objects for this operation`)
    this.name = "MissingGrant"
  }
}

/**
 * Run `fn` in one transaction, as the caller.
 *
 * Every read, write and delete of `storage.objects` made for a request runs through here, so the
 * policies generated from the bucket's declared rules decide it, rather than a second copy of those
 * rules in this service. Writes used to run on the shared pool, which connects as the database owner
 * and bypasses row level security. The policies were right and nothing consulted them, so the anon
 * key could upload to a bucket declaring `create: BucketLoggedIn` (supatype#81) and any signed-in
 * user could delete anyone's files (supatype#82).
 *
 * The service role is not switched: it is the server's own key, and the owner connection is what it
 * has always run as. Everything set here is local to the transaction, so a pooled connection is
 * never handed on still wearing a caller's role. Ends with `end` when `fn` resolves (a rehearsal
 * passes ROLLBACK) and rolls back when it throws.
 *
 * @throws {UnknownRole} for a role the gateway does not issue.
 * @throws {MissingGrant} when the database predates the grants `privileges` names.
 */
async function asCaller<T>(
  jwt: JwtPayload,
  privileges: readonly Privilege[],
  fn: (client: pg.PoolClient) => Promise<T>,
  end: "COMMIT" | "ROLLBACK" = "COMMIT",
): Promise<T> {
  if (!CALLER_ROLES.has(jwt.role)) throw new UnknownRole(jwt.role)
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    if (!isServiceRole(jwt)) await becomeCaller(client, jwt, privileges)
    const result = await fn(client)
    await client.query(end)
    return result
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
}

/**
 * Wear the caller's identity for the rest of the transaction, and confirm their role holds the
 * grants the operation needs. One statement for all of it, so this costs one round trip.
 *
 * `auth.uid()` and `auth.role()` read the claims, which is what the generated policies call.
 * `set_config('role', ...)` is `SET LOCAL ROLE` taking a parameter, so the claim never becomes SQL
 * text. The grant check names the role, so it does not depend on the switch having happened.
 *
 * Asked up front because a write refused by a policy and a write refused for want of a grant share
 * one SQLSTATE, and they mean opposite things: one is the bucket's rule working, the other is a
 * deployment whose database predates the grants, which `supatype push` fixes.
 */
async function becomeCaller(client: pg.PoolClient, jwt: JwtPayload, privileges: readonly Privilege[]): Promise<void> {
  const res = await client.query<{ held: boolean }>(
    `SELECT set_config('request.jwt.claims', $1, true),
            set_config('request.jwt.claim.sub', $2, true),
            set_config('role', $3, true),
            has_schema_privilege($3, 'storage', 'USAGE')
              AND (SELECT bool_and(has_table_privilege($3, 'storage.objects', p))
                     FROM unnest($4::text[]) AS p) AS held`,
    [JSON.stringify(jwt), jwt.sub ?? "", jwt.role, privileges],
  )
  if (res.rows[0]?.held !== true) throw new MissingGrant(jwt.role)
}

/** Log once per refusal what the operator has to run. */
export function reportMissingGrant(err: MissingGrant): void {
  console.error(
    `[storage] permission denied on storage.objects as ${err.role}. This deployment's database is ` +
      "missing the grants the bucket rules need. Run `supatype push` to apply them.",
  )
}

/**
 * Can this caller see this object, according to the database?
 *
 * The bucket's declared read rule already exists as an RLS policy on `storage.objects`, so asking
 * Postgres is asking the rule itself. The middleware used to decide this from `access_mode` alone
 * and hardcoded owner-only for every private bucket, so a bucket declaring `BucketLoggedIn` refused
 * every user but the uploader.
 */
export async function objectVisibleTo(bucketId: string, name: string, jwt: JwtPayload): Promise<boolean> {
  try {
    return await asCaller(jwt, ["SELECT"], async (client) => {
      const res = await client.query(
        `SELECT 1 FROM storage.objects WHERE bucket_id = $1 AND name = $2 LIMIT 1`,
        [bucketId, name],
      )
      return (res.rowCount ?? 0) > 0
    })
  } catch (err) {
    // Refused rather than rethrown: a missing grant must never read as "allowed", and a 500 naming
    // a Postgres table tells an operator nothing about what to do. The log says what to run.
    if (err instanceof MissingGrant) reportMissingGrant(err)
    if (err instanceof MissingGrant || err instanceof UnknownRole) return false
    throw err
  }
}

/** An object's name and which stored copy of its bytes is live. */
export interface StoredObject {
  name: string
  version: string | null
}

/** What the rules said about an upload. */
export type WriteOutcome = "written" | "exists" | "refused"

/** An object to record. Its owner is always the caller, so it is not a field here. */
export interface ObjectWrite {
  bucketId: string
  name: string
  metadata: Record<string, unknown>
}

/** A committed write, and the version it replaced, whose bytes are now the caller's to delete. */
export type CommittedWrite =
  | { outcome: "written"; replaced: StoredObject | null }
  | { outcome: "exists" | "refused" }

function uploadPrivileges(upsert: boolean): Privilege[] {
  return upsert ? ["SELECT", "INSERT", "UPDATE"] : ["INSERT"]
}

/**
 * Would the bucket's rules accept this upload? Asked before any bytes are read into S3.
 *
 * The row is written as the caller, so the policies decide, and then rolled back. Supabase's
 * storage-api checks the same way (`testPermission`). The bytes are uploaded with no transaction
 * open, and `commitUploadAs` asks the rules again when it records the row.
 *
 * @throws {MissingGrant} when the database predates the grants this needs.
 * @throws {UnknownRole} for a role the gateway does not issue.
 */
export async function checkUploadAs(jwt: JwtPayload, write: ObjectWrite, upsert: boolean): Promise<WriteOutcome> {
  return asCaller(
    jwt,
    uploadPrivileges(upsert),
    async (client) => (await writeRow(client, write, jwt.sub ?? null, upsert, null)).outcome,
    "ROLLBACK",
  )
}

/**
 * Record an upload whose bytes are already stored under `version`, as the caller.
 *
 * As the caller rather than as the owner, unlike Supabase, so the rules are asked again at the
 * moment the row is written and nothing that changed since the check slips through. Uploads to one
 * path are serialised by an advisory lock, so of two concurrent creates one wins and the other is
 * `exists`. An overwrite keeps the object's owner.
 *
 * @throws {MissingGrant} when the database predates the grants this needs.
 * @throws {UnknownRole} for a role the gateway does not issue.
 */
export async function commitUploadAs(
  jwt: JwtPayload,
  write: ObjectWrite,
  upsert: boolean,
  version: string,
): Promise<CommittedWrite> {
  return asCaller(jwt, uploadPrivileges(upsert), async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `storage.objects/${write.bucketId}/${write.name}`,
    ])
    return writeRow(client, write, jwt.sub ?? null, upsert, version)
  })
}

/** Overwrite the object when asked to and allowed to, otherwise insert it. */
async function writeRow(
  client: pg.PoolClient,
  write: ObjectWrite,
  owner: string | null,
  upsert: boolean,
  version: string | null,
): Promise<CommittedWrite> {
  if (upsert) {
    const replaced = await overwriteObject(client, write, version)
    if (replaced !== undefined) return { outcome: "written", replaced }
  }
  return insertObject(client, write, owner, upsert, version)
}

/**
 * Overwrite the object if it exists and the caller's update rule allows it, returning the version
 * it replaced, or undefined when nothing was overwritten.
 */
async function overwriteObject(
  client: pg.PoolClient,
  write: ObjectWrite,
  version: string | null,
): Promise<StoredObject | null | undefined> {
  // Rows the update rule does not allow are filtered out rather than raising, so "no row" means
  // either absent or not the caller's to change, and the insert after this tells the two apart.
  const res = await client.query<{ previous: string | null }>(
    `UPDATE storage.objects AS o
        SET metadata = $3, version = $4, updated_at = now(), last_accessed_at = now()
       FROM (SELECT id, version AS previous FROM storage.objects WHERE bucket_id = $1 AND name = $2) AS p
      WHERE o.id = p.id
      RETURNING p.previous`,
    [write.bucketId, write.name, JSON.stringify(write.metadata), version],
  )
  const previous = res.rows[0]
  return previous === undefined ? undefined : { name: write.name, version: previous.previous }
}

async function insertObject(
  client: pg.PoolClient,
  write: ObjectWrite,
  owner: string | null,
  upsert: boolean,
  version: string | null,
): Promise<CommittedWrite> {
  try {
    await client.query(
      `INSERT INTO storage.objects (bucket_id, name, owner, metadata, version) VALUES ($1, $2, $3, $4, $5)`,
      [write.bucketId, write.name, owner, JSON.stringify(write.metadata), version],
    )
    return { outcome: "written", replaced: null }
  } catch (err) {
    // Present but not updatable by this caller, when they asked to overwrite it.
    if (isUniqueViolation(err)) return { outcome: upsert ? "refused" : "exists" }
    if (isPolicyViolation(err)) return { outcome: "refused" }
    throw err
  }
}

/**
 * Delete objects as the caller, returning what Postgres actually deleted.
 *
 * Names the delete rule does not allow are filtered out, not raised, so the result is exactly what
 * the caller was entitled to remove. The caller deletes the bytes for those names only, and only
 * after this has committed: deleting from S3 first is how a refused delete still lost the files.
 */
export async function deleteObjectsAs(jwt: JwtPayload, bucketId: string, names: string[]): Promise<StoredObject[]> {
  if (names.length === 0) return []
  return asCaller(jwt, ["SELECT", "DELETE"], async (client) => {
    const res = await client.query<StoredObject>(
      `DELETE FROM storage.objects WHERE bucket_id = $1 AND name = ANY($2) RETURNING name, version`,
      [bucketId, names],
    )
    return res.rows
  })
}

/**
 * List a bucket as the caller: only the objects their read rule allows.
 *
 * `starts_with` rather than `LIKE`, which read `%` and `_` in a prefix as wildcards.
 */
export async function listObjectRowsAs(
  jwt: JwtPayload,
  bucketId: string,
  prefix: string,
  page: { limit: number; offset: number },
): Promise<ObjectRow[]> {
  return asCaller(jwt, ["SELECT"], async (client) => {
    const res = await client.query<ObjectRow>(
      `SELECT * FROM storage.objects
        WHERE bucket_id = $1 AND starts_with(name, $2)
        ORDER BY name
        LIMIT $3 OFFSET $4`,
      [bucketId, prefix, page.limit, page.offset],
    )
    return res.rows
  })
}

/** Whether a bucket holds any object, with the service's own connection. */
export async function bucketHasObjects(bucketId: string): Promise<boolean> {
  const res = await pool.query(`SELECT 1 FROM storage.objects WHERE bucket_id = $1 LIMIT 1`, [bucketId])
  return (res.rowCount ?? 0) > 0
}

/**
 * Record that an object was read, and say which version of its bytes to serve.
 *
 * Undefined when there is no such object. One statement for both, since every download needs the
 * version and already touched the row.
 */
export async function touchObject(bucketId: string, name: string): Promise<StoredObject | undefined> {
  const res = await pool.query<StoredObject>(
    `UPDATE storage.objects SET last_accessed_at = now() WHERE bucket_id = $1 AND name = $2
     RETURNING name, version`,
    [bucketId, name],
  )
  return res.rows[0]
}
