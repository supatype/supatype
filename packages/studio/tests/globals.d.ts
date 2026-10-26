declare global {
  /**
   * Tells React this environment drives renders through `act()`, so it warns about any update that
   * happens outside one. The suites that mount for real set it in `beforeEach`.
   */
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

export {}
