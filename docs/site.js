// Usage analytics: PostHog in the EU region, live site only. Cookieless mode stores nothing in the
// browser and counts visitors with a daily hash made on PostHog's servers, so no consent banner is
// needed. The project token is a public, write-only key by design.
const POSTHOG_TOKEN = "phc_udSTXPBgv6MJEUwEibzzYgq6DYAVw53SQ3sX5q2omJjx"
const live = location.hostname === "www.supatype.com"
// Events sent before the library has loaded wait here.
const pending = []

// Every event carries the page it was sent from as source.
function track(event, properties = {}, options) {
  if (!live) return
  properties = { source: location.pathname, ...properties }
  if (window.posthog?.__loaded) window.posthog.capture(event, properties, options)
  else pending.push([event, properties, options])
}

if (live) {
  const script = document.createElement("script")
  script.src = "https://eu-assets.i.posthog.com/static/array.js"
  script.async = true
  script.onload = () => window.posthog?.init(POSTHOG_TOKEN, {
    api_host: "https://eu.i.posthog.com",
    cookieless_mode: "always",
    person_profiles: "identified_only",
    loaded: (posthog) => pending.splice(0).forEach((args) => posthog.capture(...args)),
  })
  document.head.append(script)
}

// A page can send one event when it opens, named by data-event-on-load on <body> (the 404 page).
if (document.body.dataset.eventOnLoad) {
  track(document.body.dataset.eventOnLoad, { referrer: document.referrer })
}

// A link or button with data-event sends that event, with data-where saying which one it was.
// Moving through the docs by sidebar, "On this page" or previous/next sends docs_nav. Any other
// link off the site sends outbound_clicked.
const docsNav = [[".docs-side", "sidebar"], [".toc", "toc"], [".pn", "pager"]]

document.addEventListener("click", (event) => {
  const tagged = event.target.closest("[data-event]")
  if (tagged) return track(tagged.dataset.event, { where: tagged.dataset.where })
  const link = event.target.closest("a[href]")
  if (!link) return
  const where = docsNav.find(([selector]) => link.closest(selector))?.[1]
  if (where) return track("docs_nav", { where, to: link.pathname + link.hash })
  if (link.hostname !== location.hostname) track("outbound_clicked", { url: link.href })
})

// Sign-up forms: the Cloud waiting list and "book a call". A form names the event it sends in
// data-submit-event and its thank-you line in data-done, where {email} stands for the address given.
// Giving an email is consent to be identified by it. If PostHog never loaded (a blocker, or not
// the live site), the form shows its own "blocked" message instead.
document.addEventListener("submit", (event) => {
  const form = event.target
  if (!form.matches(".signup")) return
  event.preventDefault()
  const status = form.querySelector("[role='status']")
  const blocked = form.querySelector(".signup-blocked")
  if (!status || !blocked) return
  if (!window.posthog?.__loaded) return status.replaceChildren(blocked.content.cloneNode(true))
  const { email: { value }, note } = form.elements
  const email = value.trim()
  window.posthog.identify(email, { email })
  track(form.dataset.submitEvent, { note: note?.value.trim() || undefined }, { send_instantly: true })
  for (const part of form.children) part.hidden = part !== status
  status.textContent = form.dataset.done.replace("{email}", email)
})

// Copy to clipboard. A button with data-copy copies that text; a code block's Copy button copies
// its block, minus the "$ " prompts and the output lines of a terminal session.
function commandsFrom(text) {
  const lines = text.replace(/\n$/, "").split("\n")
  const commands = lines.filter((line) => line.startsWith("$ "))
  if (commands.length === 0) return lines.join("\n")
  return commands.map((line) => line.slice(2).replace(/\s+#.*$/, "")).join("\n")
}

// The label to go back to is kept on the button the first time, so a second click inside the
// 1.5 seconds cannot save "Copied" as the label.
const resetTimers = new WeakMap()

async function copy(button, text) {
  // A text button says "Copied" for a moment; an icon button announces it to screen readers.
  const iconOnly = button.childElementCount > 0
  button.dataset.label ??= iconOnly ? button.getAttribute("aria-label") : button.textContent
  const show = iconOnly ? (value) => button.setAttribute("aria-label", value) : (value) => { button.textContent = value }
  try {
    await navigator.clipboard.writeText(text)
    track("command_copied", { command: text })
    show("Copied")
    clearTimeout(resetTimers.get(button))
    resetTimers.set(button, setTimeout(() => show(button.dataset.label), 1500))
  } catch {
    // Clipboard unavailable: the text is still on screen to select by hand.
  }
}

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-copy], .cb-copy")
  if (!button) return
  const text = button.dataset.copy ?? commandsFrom(button.closest(".cb")?.querySelector("pre")?.textContent ?? "")
  copy(button, text)
})

// Disclosure buttons: the main nav drawer and the docs section menu. Each button names the
// element it opens with aria-controls. Escape or following a link inside closes it.
const reveal = {
  "nav-drawer": (drawer, open) => { drawer.hidden = !open },
  "docs-side": (side, open) => side.classList.toggle("is-open", open),
}

function setOpen(button, open) {
  const target = document.getElementById(button.getAttribute("aria-controls"))
  if (!target) return
  button.setAttribute("aria-expanded", String(open))
  reveal[target.id]?.(target, open)
}

const menuButtons = document.querySelectorAll(".nav-menu, .docs-menu")

menuButtons.forEach((button) => {
  button.addEventListener("click", () => setOpen(button, button.getAttribute("aria-expanded") !== "true"))
  document.getElementById(button.getAttribute("aria-controls"))?.addEventListener("click", (event) => {
    if (event.target.closest("a")) setOpen(button, false)
  })
})

// Past the phone layout the menus are not used, so an open one closes rather than staying open
// under the full nav.
matchMedia("(min-width: 761px)").addEventListener("change", (event) => {
  if (event.matches) menuButtons.forEach((button) => setOpen(button, false))
})

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return
  const open = [...menuButtons].find((button) => button.getAttribute("aria-expanded") === "true")
  if (!open) return
  setOpen(open, false)
  open.focus()
})

// The sticky header's height, kept in --header-h so anchors and sticky columns clear it even when
// the nav wraps. Measured on the nav bar, not the header, so an open drawer does not count. The
// value in site.css stands in until this runs.
const navBar = document.querySelector(".site-header .nav")
let headerHeight = navBar?.offsetHeight ?? 0
if (navBar) {
  new ResizeObserver(() => {
    headerHeight = navBar.offsetHeight
    document.documentElement.style.setProperty("--header-h", `${headerHeight}px`)
  }).observe(navBar)
}

// Mark the nav, sidebar and "On this page" links for the part of the page in view. Links are
// grouped by the id they point at, once, up front.
const linksById = new Map()
for (const a of document.querySelectorAll(".nav-links a[href^='#'], .nav-drawer a[href^='#'], .docs-side a[href*='#'], .toc a[href^='#']")) {
  if (a.pathname !== location.pathname) continue
  const id = a.hash.slice(1)
  if (!linksById.has(id)) linksById.set(id, [])
  linksById.get(id).push(a)
}
// Each target with the <section> it sits in, found once.
const targets = [...linksById.keys()]
  .map((id) => document.getElementById(id))
  .filter(Boolean)
  .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
  .map((element) => ({ element, section: element.closest("section") }))

// A target covers from its top to the next target, or to the end of the <section> it is in,
// whichever comes first. A target in no section (a docs heading) also covers the page above it.
// The line that decides sits a little below the sticky header.
function currentId() {
  const line = headerHeight + innerHeight * 0.15
  let id = targets[0]?.section ? null : targets[0]?.element.id
  for (const { element, section } of targets) {
    if (element.getBoundingClientRect().top > line) break
    const end = section?.getBoundingClientRect().bottom ?? Infinity
    id = end > line ? element.id : null
  }
  return id
}

let shownId = [...linksById].find(([, links]) => links.some((a) => a.hasAttribute("aria-current")))?.[0]
let frame = 0
function markCurrent() {
  frame = 0
  const id = currentId()
  if (id === shownId) return
  linksById.get(shownId)?.forEach((a) => a.removeAttribute("aria-current"))
  linksById.get(id)?.forEach((a) => a.setAttribute("aria-current", "location"))
  shownId = id
}
if (targets.length > 0) {
  markCurrent()
  const schedule = () => { frame ||= requestAnimationFrame(markCurrent) }
  addEventListener("scroll", schedule, { passive: true })
  addEventListener("resize", schedule)
}
