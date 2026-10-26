/**
 * SQL for the owner-only tables the integration tests judge changes on, shaped like what the
 * engine generates, so every suite imitates the engine the same way.
 */

export const OWNER_RULE = `owner = current_setting('request.jwt.claims', true)::jsonb->>'sub'`

/** The extension and role every integration suite needs before it creates a table. */
export const PREAMBLE = `
  CREATE EXTENSION IF NOT EXISTS supatype_mask;
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      CREATE ROLE authenticated;
    END IF;
  END $$;`

/** A table with the owner-only policy the engine generates for `read: Owner<"owner">`. */
export function ownedTable(name: string, columns: string, extra = ""): string {
  return `
    DROP TABLE IF EXISTS ${name} CASCADE;
    CREATE TABLE ${name} (${columns});
    ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY;
    CREATE POLICY ${name}_read ON ${name} FOR SELECT TO authenticated USING (${OWNER_RULE});
    GRANT SELECT ON ${name} TO authenticated;
    ${extra}`
}

/**
 * The row predicate the engine emits for the same rule. From 0.7 it takes a second, defaulted
 * parameter that keeps it out of GraphQL (CT3); `rowOnly` is the shape an older engine left, the
 * table's row alone, which a database it last pushed still has.
 */
export function readPredicate(table: string, opts: { rowOnly?: boolean } = {}): string {
  const outOfGraphql = opts.rowOnly === true ? "" : `, "not_in_graphql" boolean DEFAULT NULL`
  return `
    CREATE OR REPLACE FUNCTION public.can_read_${table}(${table} public.${table}${outOfGraphql})
      RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT ${OWNER_RULE} FROM (SELECT ($1).*) AS ${table};
      $$;`
}

/** A column nobody but service_role may read: its field predicate is always false. */
export function unreadableColumn(table: string, column: string): string {
  const predicate = `can_read_${table}__${column}`
  return `
    CREATE OR REPLACE FUNCTION public.${predicate}(${table} public.${table})
      RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false FROM (SELECT ($1).*) AS ${table}; $$;
    SECURITY LABEL FOR supatype ON COLUMN ${table}.${column} IS 'MASK READ public."${predicate}"';`
}
