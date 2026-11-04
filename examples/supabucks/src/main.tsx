import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "./App"
import { AuthProvider } from "./useAuth"
// The package stylesheet goes first so styles.css can override it.
import "@supatype/ui/styles.css"
import "./styles.css"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </StrictMode>,
)
