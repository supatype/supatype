// Turns a page of the static site into Markdown, for the generated half of llms-full.txt. It
// knows only the markup the docs pages use: headings, paragraphs, lists, tables, code blocks,
// callouts, numbered steps and cards. Text that no rule reads stops the run with the page's name,
// so nothing is dropped from llms-full.txt without a word.

export const site = "https://www.supatype.com"

const entities = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " }
const entityPattern = new RegExp(Object.keys(entities).join("|"), "g")
const decode = (text) => text.replace(entityPattern, (entity) => entities[entity])
const stripTags = (html) => html.replace(/<[^>]+>/g, "")

// A link's target as a full URL: a #fragment points into the page it is on.
function absolute(href, url) {
  if (href.startsWith("#")) return `${site}${url}${href}`
  return href.startsWith("/") ? `${site}${href}` : href
}

function inline(html, url) {
  const text = html
    .replace(/<code>([\s\S]*?)<\/code>/g, (_, code) => `\`${stripTags(code)}\``)
    .replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, (_, href, label) => `[${stripTags(label)}](${absolute(href, url)})`)
    .replace(/<\/?strong>/g, "**")
    .replace(/<\/?em>/g, "*")
  return decode(stripTags(text)).replace(/\s+/g, " ").trim()
}

// The code block's bar names a file or says "terminal"; the name goes above the fence.
function codeBlock(name, code) {
  const body = decode(stripTags(code)).replace(/\n+$/, "")
  const lang = name === "terminal" ? "sh" : (name.match(/\.(ts|tsx|js|json|ya?ml|sql|toml)$/)?.[1] ?? "")
  return `${name === "terminal" ? "" : `\`${name}\`:\n\n`}\`\`\`${lang}\n${body}\n\`\`\``
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

function table(html, url) {
  const rows = items(html, /<tr[^>]*>([\s\S]*?)<\/tr>/g, url, "table markup").map(([, row]) =>
    items(row, /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g, url, "table row markup").map(([, cell]) => inline(cell, url).replace(/\|/g, "\\|")))
  if (rows.length === 0) throw new Error(`${url}: a table with no rows`)
  const line = (cells) => `| ${cells.join(" | ")} |`
  return [line(rows[0]), line(rows[0].map(() => "---")), ...rows.slice(1).map(line)].join("\n")
}

// A card has an <h3> or <strong> title, and may carry a label above it (the licence cards). Each
// card is its own paragraph, not a bullet, so a list that follows the cards stays a separate list.
const cards = (html, url) => items(html, /<div>(?:<span class="label">([^<]*)<\/span>)?<(h3|strong)>([\s\S]*?)<\/\2><p>([\s\S]*?)<\/p><\/div>/g, url, "card markup")
  .map(([, label, , title, body]) => `**${inline(title, url)}**${label ? ` (${inline(label, url)})` : ""}: ${inline(body, url)}`).join("\n\n")

// A list of plain <li> items. A nested list has no rule either.
function list(html, url) {
  if (/<[ou]l[\s>]/.test(html)) throw new Error(`${url}: no Markdown rule for a nested list`)
  return items(html, /<li>([\s\S]*?)<\/li>/g, url, "list markup").map(([, item]) => `- ${inline(item, url)}`).join("\n")
}

const callout = (label, body, url) => `> **${inline(label, url)}:** ${inline(body.replace(/<\/p>\s*<p>/g, " "), url)}`

// Block rules, in the order they run. Each finished block is set aside as a placeholder so later
// rules cannot touch it, then put back at the end.
const blockRules = [
  [/<div class="cb"><div class="cb-bar"><span>([^<]*)<\/span>[\s\S]*?<\/div>\s*<pre>([\s\S]*?)<\/pre><\/div>/g, (url, name, code) => codeBlock(name, code)],
  [/<div class="tbl">([\s\S]*?)<\/div>/g, (url, html) => table(html, url)],
  [/<div class="cards[^"]*">((?:\s*<div>[\s\S]*?<\/div>)+)\s*<\/div>/g, (url, html) => cards(html, url)],
  [/<div class="callout[^"]*">\s*<span class="callout-label">([\s\S]*?)<\/span>([\s\S]*?)<\/div>/g, (url, label, body) => callout(label, body, url)],
  // A step is numbered, or marked "+" when it is optional.
  [/<div class="step"><span class="step-num">([^<]*)<\/span><h3>([\s\S]*?)<\/h3><\/div>/g, (url, n, title) => `#### ${/^\d+$/.test(n) ? `${n}. ` : ""}${inline(title, url)}`],
  [/<h2[^>]*>([\s\S]*?)<\/h2>/g, (url, html) => `### ${inline(html, url)}`],
  [/<h3[^>]*>([\s\S]*?)<\/h3>/g, (url, html) => `#### ${inline(html, url)}`],
  [/<ul[^>]*>([\s\S]*?)<\/ul>/g, (url, html) => list(html, url)],
  [/<p[^>]*>([\s\S]*?)<\/p>/g, (url, html) => inline(html, url)],
]

// The page's article, from its <h1> to the previous/next links, as one "## Title" section.
export function pageMarkdown(html, url) {
  const article = html.match(/<h1>([^<]*)<\/h1>([\s\S]*?)<nav class="pn"/)
  if (!article) throw new Error(`${url}: no <h1> to previous/next article`)
  const blocks = []
  let body = article[2]
  for (const [pattern, render] of blockRules) {
    body = body.replace(pattern, (_, ...groups) => `\u0000${blocks.push(render(url, ...groups)) - 1}\u0000`)
  }
  unhandled(url, body.replace(/\u0000\d+\u0000/g, ""), "text")
  const text = [...body.matchAll(/\u0000(\d+)\u0000/g)].map(([, i]) => blocks[Number(i)].replace(/\u0000(\d+)\u0000/g, (_, j) => blocks[Number(j)]))
  return [`## ${decode(article[1])}`, `Source: ${site}${url}`, ...text].join("\n\n")
}
