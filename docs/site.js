// Copy to clipboard. A button with data-copy copies that text; a code block's Copy button copies
// its block, minus the "$ " prompts and the output lines of a terminal session.
function commandsFrom(text) {
  const lines = text.replace(/\n$/, "").split("\n")
  const commands = lines.filter((line) => line.startsWith("$ "))
  if (commands.length === 0) return lines.join("\n")
  return commands.map((line) => line.slice(2).replace(/\s+#.*$/, "")).join("\n")
}

async function copy(button, text) {
  // A text button says "Copied" for a moment; an icon button announces it to screen readers.
  const show = button.childElementCount === 0
    ? (value) => { button.textContent = value }
    : (value) => button.setAttribute("aria-label", value)
  const before = button.childElementCount === 0 ? button.textContent : button.getAttribute("aria-label")
  try {
    await navigator.clipboard.writeText(text)
    show("Copied")
    setTimeout(() => show(before), 1500)
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

document.querySelectorAll(".nav-menu, .docs-menu").forEach((button) => {
  button.addEventListener("click", () => setOpen(button, button.getAttribute("aria-expanded") !== "true"))
  document.getElementById(button.getAttribute("aria-controls"))?.addEventListener("click", (event) => {
    if (event.target.closest("a")) setOpen(button, false)
  })
})

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return
  const open = document.querySelector(".nav-menu[aria-expanded='true'], .docs-menu[aria-expanded='true']")
  if (!open) return
  setOpen(open, false)
  open.focus()
})

// On a page with several sections, mark the sidebar and "On this page" links for the section
// in view. Links are grouped by the section id they point at, once, up front.
const linksById = new Map()
for (const a of document.querySelectorAll(".docs-side a[href*='#'], .toc a[href^='#']")) {
  if (a.pathname !== location.pathname) continue
  const id = a.hash.slice(1)
  linksById.set(id, [...(linksById.get(id) ?? []), a])
}
if (linksById.size > 0 && "IntersectionObserver" in window) {
  let current = [...linksById.values()].flat().filter((a) => a.hasAttribute("aria-current"))
  const observer = new IntersectionObserver(
    (entries) => {
      const entry = entries.filter((e) => e.isIntersecting).at(-1)
      if (!entry) return
      current.forEach((a) => a.removeAttribute("aria-current"))
      current = linksById.get(entry.target.id) ?? []
      current.forEach((a) => a.setAttribute("aria-current", "location"))
    },
    { rootMargin: "-20% 0px -70% 0px" },
  )
  linksById.forEach((_, id) => {
    const section = document.getElementById(id)
    if (section) observer.observe(section)
  })
}
