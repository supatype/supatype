/**
 * Postinstall script — @supatype/cli global/project install.
 *
 * Host binaries (engine, server, postgres, deno) are downloaded on demand:
 * - native provider: first supatype dev / supatype update
 * - docker provider: Compose images on first supatype dev
 */

async function main() {
  console.log(
    "[supatype] CLI installed. " +
      "Runtime components download automatically on first use " +
      "(supatype dev or supatype update).",
  )
}

main().catch((err) => {
  console.error("[supatype] Postinstall failed:", err)
  process.exit(0)
})
