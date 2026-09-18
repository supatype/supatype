import React from "react"
import { createRoot } from "react-dom/client"
import { SupatypeProvider } from "@supatype/react"
import { supatype } from "./client.js"
import { App } from "./App.js"
import "./styles.css"

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SupatypeProvider client={supatype}>
      <App />
    </SupatypeProvider>
  </React.StrictMode>,
)
