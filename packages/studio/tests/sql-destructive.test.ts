import { describe, expect, it } from "vitest"
import { isDestructiveSql } from "../src/lib/sql-destructive.js"

/**
 * Owner rule: reviewed SQL asks a second question only when it drops or destroys something.
 * Creating, replacing or enabling runs straight after review. One rule decides it for every screen,
 * and it reads the statement as it will run, so an edited draft is judged by what it now says.
 */

const DESTRUCTIVE = [
  'DROP TABLE "public"."orders";',
  "drop view v;",
  'DROP FUNCTION "public"."do_it"();',
  'DROP TRIGGER "audit" ON "public"."orders";',
  'DROP TYPE "public"."mood";',
  'DROP POLICY "owner_read" ON "public"."todos";',
  'ALTER TABLE "public"."todos" DISABLE ROW LEVEL SECURITY;',
  "ALTER TABLE t NO FORCE ROW LEVEL SECURITY;",
  "ALTER TABLE t DROP COLUMN c;",
  "TRUNCATE t;",
  "DELETE FROM t WHERE id = 1;",
  "UPDATE t SET a = 1;",
  "REVOKE ALL ON t FROM app;",
  "CREATE TABLE a (id int);\nDROP TABLE b;",
  "-- tidy up\nDROP TABLE x;",
  "/* gone */ DROP TABLE x;",
  "WITH gone AS (DELETE FROM t RETURNING *) SELECT * FROM gone;",
  "DO $$ BEGIN EXECUTE 'x'; END $$;",
]

const SAFE = [
  "",
  "CREATE TABLE a (id bigint PRIMARY KEY, b bigint REFERENCES c (id) ON DELETE CASCADE ON UPDATE SET NULL);",
  "CREATE OR REPLACE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$\nBEGIN\n  DELETE FROM t;\nEND;\n$$;",
  "CREATE OR REPLACE FUNCTION f() RETURNS void LANGUAGE sql AS $body$ TRUNCATE t $body$;",
  "CREATE OR REPLACE VIEW v AS\nSELECT 'drop table x' AS s;",
  "CREATE POLICY p ON t FOR DELETE USING (true);",
  'ALTER TABLE "public"."todos" ENABLE ROW LEVEL SECURITY;',
  "CREATE OR REPLACE TRIGGER t BEFORE DELETE ON x FOR EACH ROW EXECUTE FUNCTION f();",
  "CREATE TYPE mood AS ENUM ('drop', 'delete');",
  "SELECT 1; -- DROP TABLE x",
  'CREATE TABLE "drop" (id int);',
  "GRANT DELETE ON t TO app;",
]

describe("isDestructiveSql", () => {
  it.each(DESTRUCTIVE)("asks before %j", (sql) => {
    expect(isDestructiveSql(sql)).toBe(true)
  })

  it.each(SAFE)("runs %j straight after review", (sql) => {
    expect(isDestructiveSql(sql)).toBe(false)
  })
})
