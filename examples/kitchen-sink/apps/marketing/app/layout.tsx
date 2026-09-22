import React from "react"
import "./globals.css"

export const metadata = {
  title: "Kitchen Sink Conference",
  description: "The marketing half of the Supatype kitchen sink: published, translated, rendered on the server.",
}

export default function RootLayout({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <html lang="en">
      <body>
        <header className="ks-top">
          <a href="/">Kitchen Sink Conference</a>
          <nav>
            <a href="/talks">Talks</a>
            <a href="/api/talks">API</a>
          </nav>
        </header>
        <main className="ks-main">{children}</main>
        <footer className="ks-foot">
          Rendered on the server. Nothing below was fetched by the browser.
        </footer>
      </body>
    </html>
  )
}
