// Copy-to-clipboard for install commands.
document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const hint = button.querySelector(".hint")
    try {
      await navigator.clipboard.writeText(button.dataset.copy)
      if (hint) {
        hint.textContent = "copied"
        setTimeout(() => { hint.textContent = "copy" }, 1500)
      }
    } catch {
      // Clipboard unavailable; the command is still visible to select by hand.
    }
  })
})

// Highlight the docs sidebar entry for the section in view.
const navLinks = new Map(
  [...document.querySelectorAll(".docs-nav a[href^='#']")].map((a) => [a.getAttribute("href").slice(1), a]),
)
if (navLinks.size > 0 && "IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        navLinks.forEach((a) => a.classList.remove("active"))
        navLinks.get(entry.target.id)?.classList.add("active")
      }
    },
    { rootMargin: "-30% 0px -60% 0px" },
  )
  navLinks.forEach((_, id) => {
    const section = document.getElementById(id)
    if (section) observer.observe(section)
  })
}
