import { createClient } from "@supatype/client"

const anonKey = import.meta.env.VITE_SUPATYPE_ANON_KEY as string | undefined
const postsEl = document.querySelector<HTMLUListElement>("#posts")!
const statusEl = document.querySelector<HTMLSpanElement>("#cache-status")!
const errorEl = document.querySelector<HTMLParagraphElement>("#error")!
const reloadBtn = document.querySelector<HTMLButtonElement>("#reload")!

if (!anonKey) {
  errorEl.hidden = false
  errorEl.textContent = "Missing VITE_SUPATYPE_ANON_KEY, check tests/integration/.env"
} else {
  const supatype = createClient({
    url: window.location.origin,
    anonKey,
    auth: { persistSession: false },
  })

  async function loadPosts(): Promise<void> {
    errorEl.hidden = true
    postsEl.innerHTML = ""

    const { data, error, meta } = await supatype
      .from("post")
      .select("id,title,excerpt,slug")
      .order("created_at", { ascending: false })
      .cache({ ttl: 60_000, server: true, public: true })

    const cacheStatus = meta?.cacheStatus ?? "BYPASS"
    statusEl.textContent = `cache: ${cacheStatus}`
    statusEl.className = `badge ${cacheStatus === "HIT" ? "hit" : cacheStatus === "MISS" ? "miss" : ""}`

    if (error) {
      errorEl.hidden = false
      errorEl.textContent = error.message
      return
    }

    if (!data?.length) {
      postsEl.innerHTML = "<li><p>No posts yet. Run <code>pnpm seed</code> in tests/integration.</p></li>"
      return
    }

    for (const post of data) {
      const li = document.createElement("li")
      // This client carries no schema, so a row's columns arrive as `unknown`.
      const title = typeof post.title === "string" ? post.title : ""
      const excerpt = typeof post.excerpt === "string" ? post.excerpt : ""
      li.innerHTML = `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(excerpt)}</p>`
      postsEl.appendChild(li)
    }
  }

  reloadBtn.addEventListener("click", () => {
    void loadPosts()
  })

  void loadPosts()
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}
