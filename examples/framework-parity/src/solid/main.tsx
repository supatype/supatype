import { render } from "solid-js/web"
import { SupatypeContext } from "@supatype/solid"
import { supatype } from "../client.js"
import { App } from "./App"
import "../styles.css"

// Solid's client arrives through a context provider, which is the third of the three idioms: a
// plugin in Vue, `setContext` in Svelte, a provider component here.
render(
  () => (
    <SupatypeContext.Provider value={supatype}>
      <App />
    </SupatypeContext.Provider>
  ),
  document.getElementById("app")!,
)
