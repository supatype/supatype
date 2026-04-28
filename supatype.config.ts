import { defineConfig } from "@supatype/cli"

export default defineConfig({
  connection:
    process.env["DATABASE_URL"] ??
    "postgresql://supatype_admin:postgres@localhost:5432/supatype",
  schema: "./schema/index.ts",
  output: {
    types: "./src/types/supatype.d.ts",
    client: "./src/lib/supatype.ts",
  },
  // Self-hosted production deployment (run: supatype self-host setup)
  // selfHost: {
  //   domain: "supatype.example.com",
  //   app: {
  //     dockerfile: "./Dockerfile",
  //     port: 3000,
  //   },
  //   ssl: {
  //     provider: "caddy",
  //     email: "you@example.com",
  //   },
  // },
})
