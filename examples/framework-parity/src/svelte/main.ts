import { mount } from "svelte"
import App from "./App.svelte"
import "../styles.css"

// Svelte's client goes in through context, set by the root component rather than a plugin — see
// App.svelte. Nothing to install here.
mount(App, { target: document.getElementById("app")! })
