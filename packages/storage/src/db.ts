import pg from "pg"
import { config } from "./env.js"

const pool = new pg.Pool({ connectionString: config.databaseUrl })

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface BucketRow {
  id: string
  name: string
  public: boolean
  file_size_limit: number | null
  allowed_mime_types: string[] | null
  created_at: string
  updated_at: string
}

export interface ObjectRow {
  id: string
  bucket_id: string
  name: string
  owner: string | null
  metadata: Record<string, unknown> | null
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
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS storage.objects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      bucket_id text NOT NULL REFERENCES storage.buckets(id),
      name text NOT NULL,
      owner uuid,
      metadata jsonb,
      path_tokens text[] GENERATED ALWAYS AS (string_to_array(name, '/')) STORED,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      last_accessed_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (bucket_id, name)
    );

    CREATE INDEX IF NOT EXISTS idx_objects_bucket_name ON storage.objects(bucket_id, name);
  `)
}

// ─── Bucket CRUD ────────────────────────────────────────────────────────────────

export async function createBucket(
  id: string,
  name: string,
  isPublic: boolean,
  fileSizeLimit?: number,
  allowedMimeTypes?: string[],
): Promise<BucketRow> {
  const res = await pool.query<BucketRow>(
    `INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [id, name, isPublic, fileSizeLimit ?? null, allowedMimeTypes ?? null],
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

export async function emptyBucket(id: string): Promise<void> {
  await pool.query(`DELETE FROM storage.objects WHERE bucket_id = $1`, [id])
}

// ─── Object metadata CRUD ───────────────────────────────────────────────────────

export async function upsertObject(
  bucketId: string,
  name: string,
  owner: string | null,
  metadata?: Record<string, unknown>,
): Promise<ObjectRow> {
  const res = await pool.query<ObjectRow>(
    `INSERT INTO storage.objects (bucket_id, name, owner, metadata)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (bucket_id, name)
     DO UPDATE SET owner = $3, metadata = $4, updated_at = now(), last_accessed_at = now()
     RETURNING *`,
    [bucketId, name, owner, metadata ? JSON.stringify(metadata) : null],
  )
  return res.rows[0]!
}

export async function getObject(bucketId: string, name: string): Promise<ObjectRow | null> {
  const res = await pool.query<ObjectRow>(
    `SELECT * FROM storage.objects WHERE bucket_id = $1 AND name = $2`,
    [bucketId, name],
  )
  return res.rows[0] ?? null
}

export async function listObjectRows(
  bucketId: string,
  prefix: string,
  limit: number,
  offset: number,
): Promise<ObjectRow[]> {
  const res = await pool.query<ObjectRow>(
    `SELECT * FROM storage.objects
     WHERE bucket_id = $1 AND ($2 = '' OR name LIKE $2 || '%')
     ORDER BY name
     LIMIT $3 OFFSET $4`,
    [bucketId, prefix, limit, offset],
  )
  return res.rows
}

export async function deleteObjectRow(bucketId: string, name: string): Promise<boolean> {
  const res = await pool.query(
    `DELETE FROM storage.objects WHERE bucket_id = $1 AND name = $2`,
    [bucketId, name],
  )
  return (res.rowCount ?? 0) > 0
}

export async function deleteObjectRows(bucketId: string, names: string[]): Promise<number> {
  if (names.length === 0) return 0
  const res = await pool.query(
    `DELETE FROM storage.objects WHERE bucket_id = $1 AND name = ANY($2)`,
    [bucketId, names],
  )
  return res.rowCount ?? 0
}

export async function touchObject(bucketId: string, name: string): Promise<void> {
  await pool.query(
    `UPDATE storage.objects SET last_accessed_at = now() WHERE bucket_id = $1 AND name = $2`,
    [bucketId, name],
  )
}
