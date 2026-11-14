-- A hand-written copy of what the engine emits for private channels (plan 14.2), for the plan's
-- LotChannel and Lobby examples. The realtime server is built against this until the engine's own
-- output replaces it, and `private-channels.integration.test.ts` runs the server's questions
-- against it in a real Postgres. Keep the signatures identical to the plan's.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;

DROP SCHEMA IF EXISTS _supatype CASCADE;
CREATE SCHEMA _supatype;
GRANT USAGE ON SCHEMA _supatype TO anon, authenticated, service_role;

DROP TABLE IF EXISTS public.lot_watchers, public.lots CASCADE;
CREATE TABLE public.lots (id uuid PRIMARY KEY, seller_id uuid NOT NULL);
CREATE TABLE public.lot_watchers (lot_id uuid NOT NULL, user_id uuid NOT NULL, PRIMARY KEY (lot_id, user_id));
ALTER TABLE public.lot_watchers ENABLE ROW LEVEL SECURITY;
-- A caller sees only their own watch rows, so a rule that reads this table through Rows<> is
-- judged as the caller, exactly as in a table policy.
CREATE POLICY own_watches ON public.lot_watchers FOR SELECT TO authenticated
  USING (user_id = (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid);
GRANT SELECT ON public.lot_watchers TO authenticated;
GRANT SELECT ON public.lots TO authenticated;

CREATE TABLE _supatype.fixture_mode (mode text NOT NULL);
INSERT INTO _supatype.fixture_mode VALUES ('declared');

CREATE FUNCTION _supatype.realtime_channel_mode() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT mode FROM _supatype.fixture_mode $$;

CREATE FUNCTION _supatype.realtime_channel_access(topic text)
RETURNS TABLE (channel text, fits boolean, can_join boolean, can_send boolean, can_track boolean)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $fn$
  -- lot:{id}
  SELECT 'LotChannel'::text, TRUE,
    (EXISTS (SELECT 1 FROM public.lot_watchers w WHERE w.lot_id = "lot"."id")
      OR coalesce(current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'role', '') = 'auctioneer'),
    (EXISTS (SELECT 1 FROM public.lots l
             WHERE l.id = "lot"."id"
               AND l.seller_id = (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid)
      OR coalesce(current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'role', '') = 'auctioneer'),
    EXISTS (SELECT 1 FROM public.lot_watchers w WHERE w.lot_id = "lot"."id")
  FROM (SELECT CASE WHEN topic ~ '^lot:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                    THEN (regexp_match(topic, '^lot:(.*)$'))[1]::uuid END AS "id") AS "lot"
  WHERE "lot"."id" IS NOT NULL
  UNION ALL
  -- lot:{id}, a topic with the prefix whose parameter does not fit
  SELECT 'LotChannel'::text, FALSE, FALSE, FALSE, FALSE
  WHERE topic ~ '^lot:[^:]+$'
    AND topic !~ '^lot:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  UNION ALL
  -- lobby
  SELECT 'Lobby'::text, TRUE,
    coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') = 'authenticated',
    coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') = 'authenticated',
    coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') = 'authenticated'
  WHERE topic = 'lobby'
$fn$;

CREATE FUNCTION _supatype.realtime_channel_send_checks() RETURNS TABLE (channel text, checks jsonb)
LANGUAGE sql STABLE AS $$
  SELECT 'LotChannel'::text,
    '{"type":"all","rules":[{"type":"event","name":"bid"},{"type":"payload","field":"amount","check":{"kind":"number","min":1}}]}'::jsonb
  UNION ALL SELECT 'Lobby'::text, NULL::jsonb
$$;

CREATE FUNCTION _supatype.realtime_channel_dependencies() RETURNS TABLE (channel text, table_schema text, table_name text)
LANGUAGE sql STABLE AS $$
  VALUES ('LotChannel'::text, 'public'::text, 'lot_watchers'::text), ('LotChannel', 'public', 'lots')
$$;

GRANT EXECUTE ON FUNCTION _supatype.realtime_channel_access(text) TO anon, authenticated;
