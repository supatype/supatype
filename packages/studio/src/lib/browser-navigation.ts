/**
 * Leaving Studio for another page, such as an OAuth provider's sign-in.
 *
 * An object rather than a bare call to `window.location.assign`, so a test can stand in for the
 * navigation a DOM test environment cannot perform.
 */
export const browserNavigation = {
  assign(url: string): void {
    window.location.assign(url)
  },
}
