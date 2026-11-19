/**
 * A build that stops before it starts because it would ship a site missing something it needs: the
 * API address or anon key (`FrontendValuesRefused`), or public values Cloud holds and could not
 * hand over (`PublicEnvUnavailable`). One base, so `supatype build` and `deploy` catch one type and
 * print its message, and anything else is a bug that propagates.
 */
export class BuildRefused extends Error {}
