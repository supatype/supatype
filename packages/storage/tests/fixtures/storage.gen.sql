-- Storage schema
-- Safe to run repeatedly (IF NOT EXISTS / CREATE OR REPLACE).

CREATE SCHEMA IF NOT EXISTS storage;

CREATE TABLE IF NOT EXISTS storage.buckets (
    id                 TEXT PRIMARY KEY,
    name               TEXT NOT NULL,
    public             BOOLEAN NOT NULL DEFAULT false,
    allowed_mime_types TEXT[],
    file_size_limit    BIGINT,
    access_mode        TEXT,
    s3_bucket_policy   TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE storage.buckets ADD COLUMN IF NOT EXISTS access_mode TEXT;
ALTER TABLE storage.buckets ADD COLUMN IF NOT EXISTS s3_bucket_policy TEXT;

CREATE TABLE IF NOT EXISTS storage.objects (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bucket_id   TEXT NOT NULL REFERENCES storage.buckets (id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    owner       UUID,
    metadata    JSONB,
    version     TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (bucket_id, name)
);

-- The key the live bytes are stored under is `name/<version>`, a fresh one per upload, so an
-- overwrite never replaces the bytes being served until its row commits. Null means the bytes are
-- at `name`, which is where every object written before versions lives.
ALTER TABLE storage.objects ADD COLUMN IF NOT EXISTS version TEXT;


-- Bucket registrations

INSERT INTO storage.buckets (id, name, public, allowed_mime_types, file_size_limit, access_mode, s3_bucket_policy)
VALUES ('avatars', 'avatars', true, NULL, NULL, 'public', NULL)
ON CONFLICT (id) DO UPDATE SET
  public             = EXCLUDED.public,
  allowed_mime_types = EXCLUDED.allowed_mime_types,
  file_size_limit    = EXCLUDED.file_size_limit,
  access_mode        = EXCLUDED.access_mode,
  s3_bucket_policy   = EXCLUDED.s3_bucket_policy,
  updated_at         = NOW();

INSERT INTO storage.buckets (id, name, public, allowed_mime_types, file_size_limit, access_mode, s3_bucket_policy)
VALUES ('dropbox', 'dropbox', false, NULL, NULL, 'private', NULL)
ON CONFLICT (id) DO UPDATE SET
  public             = EXCLUDED.public,
  allowed_mime_types = EXCLUDED.allowed_mime_types,
  file_size_limit    = EXCLUDED.file_size_limit,
  access_mode        = EXCLUDED.access_mode,
  s3_bucket_policy   = EXCLUDED.s3_bucket_policy,
  updated_at         = NOW();

INSERT INTO storage.buckets (id, name, public, allowed_mime_types, file_size_limit, access_mode, s3_bucket_policy)
VALUES ('loose', 'loose', false, NULL, NULL, 'private', NULL)
ON CONFLICT (id) DO UPDATE SET
  public             = EXCLUDED.public,
  allowed_mime_types = EXCLUDED.allowed_mime_types,
  file_size_limit    = EXCLUDED.file_size_limit,
  access_mode        = EXCLUDED.access_mode,
  s3_bucket_policy   = EXCLUDED.s3_bucket_policy,
  updated_at         = NOW();

INSERT INTO storage.buckets (id, name, public, allowed_mime_types, file_size_limit, access_mode, s3_bucket_policy)
VALUES ('vault', 'vault', false, NULL, NULL, 'custom', NULL)
ON CONFLICT (id) DO UPDATE SET
  public             = EXCLUDED.public,
  allowed_mime_types = EXCLUDED.allowed_mime_types,
  file_size_limit    = EXCLUDED.file_size_limit,
  access_mode        = EXCLUDED.access_mode,
  s3_bucket_policy   = EXCLUDED.s3_bucket_policy,
  updated_at         = NOW();

-- Storage RLS

ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA storage TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO anon, authenticated;

DO $retire_storage_policies$
DECLARE p record;
BEGIN
  IF to_regclass('storage.objects') IS NULL THEN RETURN; END IF;
  FOR p IN
    SELECT polname FROM pg_policy
     WHERE polrelid = 'storage.objects'::regclass
       AND (obj_description(oid, 'pg_policy') LIKE 'supatype:managed;kind=storage_policy;%'
         OR (obj_description(oid, 'pg_policy') IS NULL
             AND polname ~ '^storage_[A-Za-z0-9_]+_(sel|ins|del)$'))
       AND polname <> ALL (ARRAY['storage_avatars_sel', 'storage_avatars_ins', 'storage_avatars_upd', 'storage_avatars_del', 'storage_dropbox_sel', 'storage_dropbox_ins', 'storage_vault_sel', 'storage_vault_ins']::text[])
  LOOP
    EXECUTE format('DROP POLICY %I ON storage.objects', p.polname);
  END LOOP;
END
$retire_storage_policies$;

-- Declarative storage policies for bucket id (sanitized label: avatars)
DROP POLICY IF EXISTS "storage_avatars_sel" ON storage.objects;
CREATE POLICY "storage_avatars_sel" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'avatars' AND (TRUE)
  );
COMMENT ON POLICY "storage_avatars_sel" ON storage.objects IS 'supatype:managed;kind=storage_policy;table=objects;fields=storage_avatars_sel;v=1';
DROP POLICY IF EXISTS "storage_avatars_ins" ON storage.objects;
CREATE POLICY "storage_avatars_ins" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'avatars' AND (auth.uid() IS NOT NULL)
  );
COMMENT ON POLICY "storage_avatars_ins" ON storage.objects IS 'supatype:managed;kind=storage_policy;table=objects;fields=storage_avatars_ins;v=1';
DROP POLICY IF EXISTS "storage_avatars_upd" ON storage.objects;
CREATE POLICY "storage_avatars_upd" ON storage.objects
  FOR UPDATE USING (
    bucket_id = 'avatars' AND (auth.uid() = owner)
  ) WITH CHECK (
    bucket_id = 'avatars' AND (auth.uid() = owner)
  );
COMMENT ON POLICY "storage_avatars_upd" ON storage.objects IS 'supatype:managed;kind=storage_policy;table=objects;fields=storage_avatars_upd;v=1';
DROP POLICY IF EXISTS "storage_avatars_del" ON storage.objects;
CREATE POLICY "storage_avatars_del" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'avatars' AND (auth.uid() = owner)
  );
COMMENT ON POLICY "storage_avatars_del" ON storage.objects IS 'supatype:managed;kind=storage_policy;table=objects;fields=storage_avatars_del;v=1';

-- Declarative storage policies for bucket id (sanitized label: dropbox)
DROP POLICY IF EXISTS "storage_dropbox_sel" ON storage.objects;
CREATE POLICY "storage_dropbox_sel" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'dropbox' AND (auth.uid() IS NOT NULL)
  );
COMMENT ON POLICY "storage_dropbox_sel" ON storage.objects IS 'supatype:managed;kind=storage_policy;table=objects;fields=storage_dropbox_sel;v=1';
DROP POLICY IF EXISTS "storage_dropbox_ins" ON storage.objects;
CREATE POLICY "storage_dropbox_ins" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'dropbox' AND (auth.uid() IS NOT NULL)
  );
COMMENT ON POLICY "storage_dropbox_ins" ON storage.objects IS 'supatype:managed;kind=storage_policy;table=objects;fields=storage_dropbox_ins;v=1';
DROP POLICY IF EXISTS "storage_dropbox_upd" ON storage.objects;
DROP POLICY IF EXISTS "storage_dropbox_del" ON storage.objects;

-- Declarative storage policies for bucket id (sanitized label: loose)
DROP POLICY IF EXISTS "storage_loose_sel" ON storage.objects;
DROP POLICY IF EXISTS "storage_loose_ins" ON storage.objects;
DROP POLICY IF EXISTS "storage_loose_upd" ON storage.objects;
DROP POLICY IF EXISTS "storage_loose_del" ON storage.objects;

-- Declarative storage policies for bucket id (sanitized label: vault)
DROP POLICY IF EXISTS "storage_vault_sel" ON storage.objects;
CREATE POLICY "storage_vault_sel" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'vault' AND (auth.uid() = owner)
  );
COMMENT ON POLICY "storage_vault_sel" ON storage.objects IS 'supatype:managed;kind=storage_policy;table=objects;fields=storage_vault_sel;v=1';
DROP POLICY IF EXISTS "storage_vault_ins" ON storage.objects;
CREATE POLICY "storage_vault_ins" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'vault' AND (auth.uid() IS NOT NULL)
  );
COMMENT ON POLICY "storage_vault_ins" ON storage.objects IS 'supatype:managed;kind=storage_policy;table=objects;fields=storage_vault_ins;v=1';
DROP POLICY IF EXISTS "storage_vault_upd" ON storage.objects;
DROP POLICY IF EXISTS "storage_vault_del" ON storage.objects;


