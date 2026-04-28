import { defineConfig } from "@supatype/cli"

export default defineConfig({
  connection: "postgresql://supatype_admin:postgres@localhost:5432/blog",
  schema: "./schema/index.ts",
  output: {
    types: "./types/database.ts",
    client: "./lib/supatype.ts",
  },
})
