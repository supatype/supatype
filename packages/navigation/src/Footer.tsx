import React from "react"

const FOOTER_SECTIONS = [
  {
    title: "Product",
    links: [
      { label: "Database", href: "/database" },
      { label: "Auth", href: "/auth" },
      { label: "Storage", href: "/storage" },
      { label: "Admin Panel", href: "/admin-panel" },
      { label: "Realtime", href: "/realtime" },
      { label: "Pricing", href: "/pricing" },
    ],
  },
  {
    title: "Developers",
    links: [
      { label: "Documentation", href: "/docs" },
      { label: "CLI Reference", href: "/docs/cli" },
      { label: "SDK Reference", href: "/docs/sdk" },
      { label: "Self-hosting", href: "/docs/self-hosting" },
      { label: "Changelog", href: "/changelog" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "Blog", href: "/blog" },
      { label: "About", href: "/about" },
      { label: "Open Source", href: "/open-source" },
      { label: "Customers", href: "/customers" },
      { label: "Contact", href: "/contact" },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Privacy Policy", href: "/privacy" },
      { label: "Terms of Service", href: "/terms" },
      { label: "Cookie Policy", href: "/cookies" },
      { label: "Acceptable Use", href: "/acceptable-use" },
    ],
  },
]

export const Footer: React.FC = () => {
  return (
    <footer className="border-t border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
          {FOOTER_SECTIONS.map((section) => (
            <div key={section.title}>
              <h3 className="text-sm font-semibold text-neutral-900 dark:text-white">
                {section.title}
              </h3>
              <ul className="mt-4 space-y-2">
                {section.links.map((link) => (
                  <li key={link.href}>
                    <a
                      href={link.href}
                      className="text-sm text-neutral-600 transition-colors hover:text-purple-600 dark:text-neutral-400 dark:hover:text-purple-400"
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col items-center justify-between gap-4 border-t border-neutral-200 pt-8 dark:border-neutral-800 md:flex-row">
          <div className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" className="text-purple-600">
              <rect width="24" height="24" rx="6" fill="currentColor" />
              <path d="M7 8h10M7 12h7M7 16h10" stroke="white" strokeWidth="2" strokeLinecap="round" />
            </svg>
            Supatype
          </div>
          <p className="text-sm text-neutral-500 dark:text-neutral-500">
            &copy; {new Date().getFullYear()} Supatype Ltd. All rights reserved.
          </p>
          <div className="flex items-center gap-4">
            <a href="https://github.com/supatype" className="text-neutral-500 hover:text-neutral-900 dark:hover:text-white" aria-label="GitHub">
              <svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.161 22 16.416 22 12c0-5.523-4.477-10-10-10z" /></svg>
            </a>
            <a href="https://twitter.com/supatype" className="text-neutral-500 hover:text-neutral-900 dark:hover:text-white" aria-label="Twitter">
              <svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>
            </a>
            <a href="https://discord.gg/supatype" className="text-neutral-500 hover:text-neutral-900 dark:hover:text-white" aria-label="Discord">
              <svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24"><path d="M20.317 4.37a19.791 19.791 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 00-.041-.106 13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128 10.2 10.2 0 00.372-.292.074.074 0 01.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127 12.299 12.299 0 01-1.873.892.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03z" /></svg>
            </a>
          </div>
        </div>
      </div>
    </footer>
  )
}
