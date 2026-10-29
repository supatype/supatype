// Turns a page of the static site into Markdown, in two styles: one section of llms-full.txt, or a
// Starlight page for the docs app that www.supatype.com moves to at cloud launch (docs-content/).
// It knows only the markup the docs pages use: headings, paragraphs, lists, tables, code blocks,
// callouts, numbered steps and cards. Text that no rule reads stops the run with the page's name,
// so nothing is dropped without a word.

export const site = "https://www.supatype.com"

const entities = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " }
const entityPattern = new RegExp(Object.keys(entities).join("|"), "g")
const decode = (text) => text.replace(entityPattern, (entity) => entities[entity])
const stripTags = (html) => html.replace(/<[^>]+>/g, "")
const sentence = (label) => label[0] + label.slice(1).toLowerCase()

// A link's target as a full URL: a #fragment points into the page it is on.
function absolute(href, url) {
  if (href.startsWith("#")) return `${site}${url}${href}`
  return href.startsWith("/") ? `${site}${href}` : href
}

// The guides move under /docs/guides/ in the docs app; every other link keeps its path.
const movedGuides = ["/deploy-vm-github-actions.html", "/from-supabase.html", "/from-prisma.html"]
function docsLink(href) {
  const [path, hash = ""] = href.split(/(?=#)/)
  return movedGuides.includes(path) ? `/docs/guides${path}${hash}` : href
}

// A code block's bar holds a file name, "terminal", "vm" (a terminal on a server), a language
// name, or a label such as "before: supabase-js" on a TypeScript snippet. Names that are only a
// language or a terminal need no title of their own.
const languageLabels = ["terminal", "typescript", "tsx"]
function languageOf(name) {
  if (name === "terminal" || name === "vm") return "sh"
  if (name === "typescript") return "ts"
  if (name.endsWith(".env")) return "ini"
  return name.match(/\.(ts|tsx|js|mjs|json|ya?ml|sql|toml|vue|svelte|prisma)$/)?.[1] ?? (name === "tsx" ? "tsx" : "ts")
}

// What differs between the two outputs. llms-full.txt nests each page under its "## Title", so
// headings go one level down; Starlight keeps the page's own levels and ids, and has asides and
// titled code blocks.
const styles = {
  llms: {
    link: absolute,
    heading: (level, id, text) => `${"#".repeat(level + 1)} ${text}`,
    code: (name, lang, body) => `${name === "terminal" ? "" : `\`${name}\`:\n\n`}\`\`\`${lang}\n${body}\n\`\`\``,
    callout: (label, text) => `> **${label}:** ${text}`,
    step: (title) => `#### ${title}`,
  },
  starlight: {
    link: docsLink,
    // An HTML heading keeps the live page's id, so links to /docs/#local-dev still land.
    heading: (level, id, text, html) => (id ? `<h${level} id="${id}">${html.trim()}</h${level}>` : `${"#".repeat(level)} ${text}`),
    code: (name, lang, body) => `\`\`\`${lang}${languageLabels.includes(name) ? "" : ` title="${name}"`}\n${body}\n\`\`\``,
    callout: (label, text) => `:::${label === "WARNING" ? "caution" : "note"}${["NOTE", "WARNING"].includes(label) ? "" : `[${sentence(label)}]`}\n${text}\n:::`,
    step: (title) => `### ${title}`,
  },
}

function inline(html, url, style) {
  const text = html
    .replace(/<code>([\s\S]*?)<\/code>/g, (_, code) => `\`${stripTags(code)}\``)
    .replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, (_, href, label) => `[${stripTags(label)}](${style.link(href, url)})`)
    .replace(/<\/?strong>/g, "**")
    .replace(/<\/?em>/g, "*")
  return decode(stripTags(text)).replace(/\s+/g, " ").trim()
}

// The code block's bar names a file or says "terminal".
function codeBlock(name, code, style) {
  const body = decode(stripTags(code)).replace(/\n+$/, "")
  const lang = languageOf(name)
  return style.code(name, lang, body)
}

// Text that no rule reads would be dropped without a word, so it stops the run instead.
function unhandled(url, html, what) {
  const rest = stripTags(html).trim()
  if (rest) throw new Error(`${url}: no Markdown rule for ${what} "${rest.slice(0, 80)}"`)
}

// The items of a table, card grid or list. Text between or around them stops the run.
function items(html, pattern, url, what) {
  unhandled(url, html.replace(pattern, ""), what)
  return [...html.matchAll(pattern)]
}

function table(html, url, style) {
  const rows = items(html, /<tr[^>]*>([\s\S]*?)<\/tr>/g, url, "table markup").map(([, row]) =>
    items(row, /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g, url, "table row markup").map(([, cell]) => inline(cell, url, style).replace(/\|/g, "\\|")))
  if (rows.length === 0) throw new Error(`${url}: a table with no rows`)
  const line = (cells) => `| ${cells.join(" | ")} |`
  return [line(rows[0]), line(rows[0].map(() => "---")), ...rows.slice(1).map(line)].join("\n")
}

// A card has an <h3> or <strong> title, and may carry a label above it (the licence cards). Each
// card is its own paragraph, not a bullet, so a list that follows the cards stays a separate list.
const cards = (html, url, style) => items(html, /<div>(?:<span class="label">([^<]*)<\/span>)?<(h3|strong)>([\s\S]*?)<\/\2><p>([\s\S]*?)<\/p><\/div>/g, url, "card markup")
  .map(([, label, , title, body]) => `**${inline(title, url, style)}**${label ? ` (${inline(label, url, style)})` : ""}: ${inline(body, url, style)}`).join("\n\n")

// A list of plain <li> items. A nested list has no rule either.
function list(html, url, style) {
  if (/<[ou]l[\s>]/.test(html)) throw new Error(`${url}: no Markdown rule for a nested list`)
  return items(html, /<li>([\s\S]*?)<\/li>/g, url, "list markup").map(([, item]) => `- ${inline(item, url, style)}`).join("\n")
}

const callout = (label, body, url, style) => style.callout(decode(stripTags(label)).trim(), inline(body.replace(/<\/p>\s*<p>/g, " "), url, style))

// A step is numbered, or marked "+" when it is optional.
const step = (n, title, url, style) => style.step(`${/^\d+$/.test(n) ? `${n}. ` : ""}${inline(title, url, style)}`)
const heading = (level) => (url, style, id, html) => style.heading(level, id, inline(html, url, style), html)

// Block rules, in the order they run. Each finished block is set aside as a placeholder so later
// rules cannot touch it, then put back at the end.
const blockRules = [
  [/<div class="cb"><div class="cb-bar"><span>([^<]*)<\/span>[\s\S]*?<\/div>\s*<pre>([\s\S]*?)<\/pre><\/div>/g, (url, style, name, code) => codeBlock(name, code, style)],
  [/<div class="tbl">([\s\S]*?)<\/div>/g, (url, style, html) => table(html, url, style)],
  [/<div class="cards[^"]*">((?:\s*<div>[\s\S]*?<\/div>)+)\s*<\/div>/g, (url, style, html) => cards(html, url, style)],
  [/<div class="callout[^"]*">\s*<span class="callout-label">([\s\S]*?)<\/span>([\s\S]*?)<\/div>/g, (url, style, label, body) => callout(label, body, url, style)],
  [/<div class="step"><span class="step-num">([^<]*)<\/span><h3>([\s\S]*?)<\/h3><\/div>/g, (url, style, n, title) => step(n, title, url, style)],
  [/<h2(?: id="([^"]*)")?[^>]*>([\s\S]*?)<\/h2>/g, heading(2)],
  [/<h3(?: id="([^"]*)")?[^>]*>([\s\S]*?)<\/h3>/g, heading(3)],
  [/<ul[^>]*>([\s\S]*?)<\/ul>/g, (url, style, html) => list(html, url, style)],
  [/<p[^>]*>([\s\S]*?)<\/p>/g, (url, style, html) => inline(html, url, style)],
]

// The page's article, from its <h1> to the previous/next links: its title and its blocks.
function article(html, url, style) {
  const found = html.match(/<h1>([^<]*)<\/h1>([\s\S]*?)<nav class="pn"/)
  if (!found) throw new Error(`${url}: no <h1> to previous/next article`)
  const blocks = []
  let body = found[2]
  for (const [pattern, render] of blockRules) {
    body = body.replace(pattern, (_, ...groups) => `\u0000${blocks.push(render(url, style, ...groups.slice(0, render.length - 2))) - 1}\u0000`)
  }
  unhandled(url, body.replace(/\u0000\d+\u0000/g, ""), "text")
  const text = [...body.matchAll(/\u0000(\d+)\u0000/g)].map(([, i]) => blocks[Number(i)].replace(/\u0000(\d+)\u0000/g, (_, j) => blocks[Number(j)]))
  return { title: decode(found[1]), text }
}

// One "## Title" section of llms-full.txt.
export function pageMarkdown(html, url) {
  const { title, text } = article(html, url, styles.llms)
  return [`## ${title}`, `Source: ${site}${url}`, ...text].join("\n\n")
}

// A Starlight page: front matter with the page's title and description, then its blocks.
export function pageStarlight(html, url) {
  const { title, text } = article(html, url, styles.starlight)
  const description = decode(html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "")
  const front = ["---", `title: ${JSON.stringify(title)}`, `description: ${JSON.stringify(description)}`, "---"].join("\n")
  return `${front}\n\n${text.join("\n\n")}\n`
}
