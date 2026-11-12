// The browser build of solid-js, imported by path so a suite can run effects under Node, where
// the package's own exports resolve to the server build. It has the package's API; only the
// declarations are missing, because solid-js ships them for the bare specifier alone.
declare module "solid-js/dist/solid.js" {
  export * from "solid-js"
}
