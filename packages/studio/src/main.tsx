import React from "react"
import { createRoot } from "react-dom/client"
import { StudioApp } from "./StudioApp.js"
import { createClient } from "@supatype/client"
import { mockConfig } from "./fixtures/mockConfig.js"
import "./globals.css"

const client = createClient({
  url: "http://localhost:8000",
  anonKey: "dev-anon-key",
})

const root = document.getElementById("root")
if (!root) throw new Error("Missing #root element")

createRoot(root).render(
  <React.StrictMode>
    <StudioApp config={mockConfig} client={client} />
  </React.StrictMode>,
)
