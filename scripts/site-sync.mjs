// Keeps the parts every page of the static site in docs/ shares in step, from one definition:
// the header, skip link and footer, the docs sidebar, the phone menu label, the previous/next
// links, the link preview and feed tags, sitemap.xml, and the docs half of llms-full.txt. The
// home page keeps its own header and footer, and gets only the head tags.
// Run after adding a page or changing a title or description. --check changes nothing and exits
// non-zero when a page is out of step:
//   node scripts/site-sync.mjs [--check]
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { pageMarkdown, site } from "./site-markdown.mjs"

const repo = fileURLToPath(new URL("../", import.meta.url))
const docs = `${repo}docs/`

// The sidebar, in reading order, each group with the header link it belongs under (none for
// More). Links without a # are pages, and they also set the order of the previous/next links,
// after Get started. A page marked { llms: false } is about this site, not the product, and stays
// out of llms-full.txt.
const sidebar = [
  ["GET STARTED", "Docs", [["Local development", "/docs/#local-dev"], ["Self-hosting", "/docs/#self-host"]]],
  ["BUILD", "Docs", [
    ["Schema", "/docs/schema.html"], ["Client", "/docs/client.html"], ["Frameworks", "/docs/frameworks.html"], ["Auth", "/docs/auth.html"],
    ["Storage", "/docs/storage.html"], ["Realtime", "/docs/realtime.html"], ["Functions", "/docs/functions.html"],
    ["Seeding", "/docs/seeding.html"], ["Studio", "/docs/studio.html"], ["Studio roles", "/docs/studio-roles.html"],
  ]],
  ["OPERATE", "Docs", [["Deploy changes", "/docs/#deploy-changes"], ["Upgrading Supatype", "/docs/#upgrading"], ["Running in production", "/docs/#production"]]],
  ["GUIDES", "Guides", [
    ["VM + GitHub Actions", "/deploy-vm-github-actions.html"],
    ["Coming from Supabase", "/from-supabase.html"], ["Coming from Prisma", "/from-prisma.html"],
  ]],
  ["REFERENCE", "Docs", [["CLI", "/docs/cli.html"]]],
  ["MORE", null, [["Licensing", "/licensing.html"], ["Privacy", "/privacy.html", { llms: false }], ["Changelog", "/changelog.html"], ["llms.txt", "/llms.txt"]]],
]

const sidebarLinks = sidebar.flatMap(([label, header, links]) =>
  links.map(([text, href, options]) => ({ label, header, text, href, llms: options?.llms ?? true })))

const pageUrls = ["/docs/", ...sidebarLinks.map((link) => link.href).filter((href) => !href.includes("#") && href.endsWith(".html"))]

const fileOf = (url) => (url.endsWith("/") ? `${url.slice(1)}index.html` : url.slice(1))
const imageOf = (url) => (url === "/" ? "home" : url === "/docs/" ? "docs" : url.split("/").pop().replace(".html", ""))
const sentence = (label) => label[0] + label.slice(1).toLowerCase()

function match(html, pattern, what, file) {
  const found = html.match(pattern)
  if (!found) throw new Error(`${file}: no ${what}`)
  return found
}

// The replacement is always a function, so a "$" in a title or description is never read as a
// replacement pattern. A string stands for itself.
function replaceOne(html, pattern, replacement, what, file) {
  match(html, pattern, what, file)
  return html.replace(pattern, typeof replacement === "function" ? replacement : () => replacement)
}

// The sidebar link that stands for a page: its own, or for Get started, which has no link of its
// own, its first section link. A page outside the sidebar (the 404 page) has none.
function sidebarEntry(url) {
  return sidebarLinks.find((link) => link.href === url) ?? sidebarLinks.find((link) => link.href.startsWith(url + "#")) ?? null
}

function sidebarHtml(url) {
  const current = sidebarEntry(url)?.href
  const groups = sidebar.map(([label, , links]) => {
    const items = links.map(([text, href]) => {
      const attr = href === current ? ` aria-current="${current === url ? "page" : "location"}"` : ""
      return `      <li><a href="${href}"${attr}>${text}</a></li>`
    })
    return `    <div><span class="label">${label}</span><ul>\n${items.join("\n")}\n    </ul></div>`
  })
  return `<nav class="docs-side" id="docs-side" aria-label="Docs">\n${groups.join("\n")}\n  </nav>`
}

function menuLabel(url) {
  const entry = sidebarEntry(url)
  return entry ? `${sentence(entry.label)}: ${entry.text}` : "Docs"
}

// A page outside the previous/next order gets no links at all.
function pagerHtml(url, headings) {
  const index = pageUrls.indexOf(url)
  if (index < 0) return ""
  const prev = pageUrls[index - 1]
  const next = pageUrls[index + 1]
  const links = [
    prev && `      <a href="${prev}"><small>PREVIOUS</small><span>${headings[prev]}</span></a>`,
    next && `      <a href="${next}" class="next"><small>NEXT</small><span>${headings[next]}</span></a>`,
  ].filter(Boolean)
  return `<nav class="pn" aria-label="More pages">\n${links.join("\n")}\n    </nav>`
}

function previewTags(html, url, file) {
  const title = match(html, /<title>([^<]*)<\/title>/, "<title>", file)[1]
  const description = match(html, /<meta name="description" content="([^"]*)"/, "meta description", file)[1]
  const canonical = match(html, /<link rel="canonical" href="([^"]*)"/, "canonical link", file)[1]
  const image = imageOf(url)
  if (!existsSync(`${docs}og/${image}.png`)) throw new Error(`${file}: missing docs/og/${image}.png`)
  // Values are copied as already escaped in the page, so they go back unchanged.
  return [
    ["property", "og:site_name", "Supatype"], ["property", "og:title", title],
    ["property", "og:description", description], ["property", "og:type", "website"],
    ["property", "og:url", canonical], ["property", "og:image", `${site}/og/${image}.png`],
    ["property", "og:image:width", "1200"], ["property", "og:image:height", "630"],
    ["name", "twitter:card", "summary_large_image"],
  ].map(([key, name, value]) => `  <meta ${key}="${name}" content="${value}" />\n`).join("")
}

const feedLink = `  <link rel="alternate" type="application/atom+xml" title="Supatype changelog" href="${site}/changelog.xml" />\n`

// The preview and feed tags go straight after the llms.txt alternate link every page carries.
function withHead(html, url, file) {
  const tags = previewTags(html, url, file)
  const stripped = html
    .replace(/^ *<meta (property="og:|name="twitter:)[^>]*>\n/gm, "")
    .replace(/^ *<link rel="alternate" type="application\/atom\+xml"[^>]*>\n/gm, "")
  return replaceOne(stripped, /^( *<link rel="alternate" type="text\/plain"[^>]*>\n)/m, (llms) => `${llms}${feedLink}${tags}`, "llms.txt alternate link", file)
}

// Guides opens on the first guide in the sidebar.
const firstLinkUnder = (header) => sidebarLinks.find((link) => link.header === header).href
const headerLinks = [["How it works", "/#how-it-works"], ["Docs", "/docs/"], ["Self-hosting", "/docs/#self-host"], ["Guides", firstLinkUnder("Guides")]]
const external = [["Discord", "https://discord.gg/TzMtynufEH"], ["GitHub", "https://github.com/supatype/supatype"]]

// The header link for the page's part of the site, from its sidebar group.
function headerSection(url) {
  const header = sidebarEntry(url)?.header
  return headerLinks.find(([text]) => text === header)?.[1] ?? null
}

function headerHtml(url) {
  const section = headerSection(url)
  const mark = (href) => (href === section ? ` aria-current="true"` : "")
  const links = headerLinks.map(([text, href]) => `      <a href="${href}"${mark(href)}>${text}</a>`).join("\n")
  const drawer = [...headerLinks.map(([text, href]) => `      <li><a href="${href}"${mark(href)}>${text}</a></li>`),
    ...external.map(([text, href]) => `      <li><a href="${href}" target="_blank" rel="noopener">${text}</a></li>`)].join("\n")
  const secondary = external.map(([text, href]) => `      <a href="${href}" class="nav-sec" target="_blank" rel="noopener">${text}</a>`).join("\n")
  return `<a href="#main" class="btn btn-primary btn-sm skip-link">Skip to content</a>

<header class="site-header">
  <nav class="nav" aria-label="Main">
    <a href="/" class="nav-logo"><img src="/supatype.svg" alt="Supatype" width="141" height="26" /></a>
    <div class="nav-links">
${links}
    </div>
    <div class="nav-end">
${secondary}
      <a href="/docs/#local-dev" class="btn btn-primary btn-sm" data-event="get_started_clicked" data-where="nav">Get started</a>
      <button type="button" class="icon-btn nav-menu" aria-label="Menu" aria-expanded="false" aria-controls="nav-drawer">
        <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M4 12h16M4 17h16"></path></svg>
      </button>
    </div>
  </nav>
  <div class="nav-drawer" id="nav-drawer" hidden>
    <ul>
${drawer}
    </ul>
  </div>
</header>`
}

const footerHtml = `<footer class="site-footer">
  <div class="wrap footer-base footer-slim">
    <span>© Supatype Ltd, a UK company · Zero drift.</span>
    <span>SDKs MIT · CLI and services Apache 2.0 · Schema engine BSL 1.1 · <a href="/licensing.html">Licensing</a> · <a href="/privacy.html">Privacy</a> · <a href="/#contact">Book a call</a></span>
  </div>
</footer>`

// Pages in the docs layout that are not in the sidebar or the previous/next order.
const extraUrls = ["/404.html"]

function syncedPage(html, url, headings) {
  const file = fileOf(url)
  let out = withHead(html, url, file)
  out = replaceOne(out, /(?:<a href="#(?:content|main)"[^>]*>Skip to content<\/a>\s*)?<header class="site-header">[\s\S]*?<\/header>/, headerHtml(url), "site header", file)
  out = replaceOne(out, /<main class="doc"[^>]*>/, `<main class="doc" id="main">`, "main", file)
  out = replaceOne(out, /<footer class="site-footer">[\s\S]*?<\/footer>/, footerHtml, "site footer", file)
  out = replaceOne(out, /<nav class="docs-side"[\s\S]*?\n  <\/nav>/, sidebarHtml(url), "docs sidebar", file)
  out = replaceOne(out, /(<button type="button" class="docs-menu"[^>]*>\s*<span>)[^<]*/, (_, button) => `${button}${menuLabel(url)}`, "docs menu button", file)
  const pager = pagerHtml(url, headings)
  if (!pager) return out.replace(/\n*\s*<nav class="pn"[\s\S]*?<\/nav>/, "")
  return replaceOne(out, /<nav class="pn"[\s\S]*?<\/nav>/, pager, "previous/next links", file)
}

// sitemap.xml lists every page with the date its file last changed in git, or today for a file
// with changes not yet committed. Two git runs answer for every file at once: the log, newest
// first, gives each path its latest commit date (the day it landed, which is what a crawler
// wants), and status marks the uncommitted ones. Today is this machine's local date.
function lastModifiedDates(files) {
  const run = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" })
  const paths = files.map((file) => `docs/${file}`)
  const now = new Date()
  const today = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((n) => String(n).padStart(2, "0")).join("-")
  const dates = new Map()
  let date = today
  for (const line of run(["log", "--format=date %cs", "--name-only", "--", ...paths]).split("\n")) {
    if (line.startsWith("date ")) date = line.slice(5)
    else if (line && !dates.has(line)) dates.set(line, date)
  }
  for (const line of run(["status", "--porcelain", "--untracked-files=all", "--no-renames", "--", ...paths]).split("\n")) {
    if (line) dates.set(line.slice(3), today)
  }
  return (file) => dates.get(`docs/${file}`) ?? today
}

function sitemapXml() {
  const entries = [["/", "index.html"], ...pageUrls.map((url) => [url, fileOf(url)]), ["/llms.txt", "llms.txt"], ["/llms-full.txt", "llms-full.txt"]]
  const lastModified = lastModifiedDates(entries.map(([, file]) => file))
  const urls = entries.map(([url, file]) => `  <url>\n    <loc>${site}${url}</loc>\n    <lastmod>${lastModified(file)}</lastmod>\n  </url>`)
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`
}

// llms-full.txt keeps its hand-written summary down to the docs heading, then carries every page
// in the sidebar as Markdown, so a language model reads the docs without scraping HTML.
const docsHeading = "## Documentation pages"

function llmsFullTxt(current, synced) {
  const summary = current.split(`\n${docsHeading}\n`)[0].trimEnd()
  const sections = pageUrls.filter((url) => sidebarEntry(url).llms).map((url) => pageMarkdown(synced[url], url))
  const intro = `Every page of the docs and guides, as Markdown, generated from the pages on ${site}/.`
  return `${summary}\n\n${docsHeading}\n\n${intro}\n\n${sections.join("\n\n")}\n`
}

const check = process.argv.includes("--check")
// Git keeps these files with LF endings, but a Windows checkout may write CRLF. Reading as LF
// keeps --check from calling every page out of step there.
const read = (file) => readFileSync(docs + file, "utf8").replace(/\r\n/g, "\n")
const pages = Object.fromEntries([...pageUrls, ...extraUrls].map((url) => [url, read(fileOf(url))]))
const headings = Object.fromEntries(pageUrls.map((url) => [url, match(pages[url], /<h1>([^<]*)<\/h1>/, "<h1>", fileOf(url))[1]]))
const synced = Object.fromEntries(Object.entries(pages).map(([url, html]) => [url, syncedPage(html, url, headings)]))
const home = read("index.html")
const llmsFull = read("llms-full.txt")
const results = [
  ...Object.keys(pages).map((url) => [fileOf(url), pages[url], synced[url]]),
  ["index.html", home, withHead(home, "/", "index.html")],
  ["llms-full.txt", llmsFull, llmsFullTxt(llmsFull, synced)],
  ["sitemap.xml", read("sitemap.xml"), sitemapXml()],
]
// A squash merge gives the sitemap's pages a new date with no change to them, so --check compares
// the sitemap's pages and not its dates. A plain run still writes the dates.
const withoutDates = (xml) => xml.replace(/<lastmod>[^<]*<\/lastmod>/g, "")
const inStep = (file, before, after) => (check && file === "sitemap.xml" ? withoutDates(before) === withoutDates(after) : before === after)
const changed = results.filter(([file, before, after]) => !inStep(file, before, after))
if (!check) changed.forEach(([file, , after]) => writeFileSync(docs + file, after))
changed.forEach(([file]) => console.log(`${check ? "out of step" : "updated"}: docs/${file}`))
console.log(`${results.length} files, ${changed.length} ${check ? "out of step" : "updated"}.`)
if (check && changed.length > 0) process.exit(1)
