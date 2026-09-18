import { createApp } from "vue"
import { supatypePlugin } from "@supatype/vue"
import { supatype } from "../client.js"
import App from "./App.vue"
import "../styles.css"

// The client reaches components through a Vue plugin, which is the idiom: one `app.use`, then
// `useSupatype()` anywhere below it.
createApp(App).use(supatypePlugin, supatype).mount("#app")
