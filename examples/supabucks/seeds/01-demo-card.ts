import type { SeedContext } from "@supatype/cli/seed"
import { MENU, REWARDS, type MenuItem, type Reward } from "../src/catalog"

/**
 * A loyalty card with some history, for the demo account, so the app has something to show on its
 * first sign-in. Run it with `pnpm seed`.
 *
 * Every row in this schema belongs to a sign-in user: `customer.id` is the user's id and each
 * `activity` names its user. A seed cannot create sign-in users, and the id `supatype admin
 * create-user` gives one is not known when this file is written, so these writes find the demo
 * account by its email inside the seed's own transaction, through `db.$sql`. Create the account
 * first (see the README); with no such account the statements match nothing and write nothing.
 *
 * Re-running is safe: the card is upserted to the totals below, and an activity row is added only
 * when the account has none with the same label.
 */
export const DEMO_EMAIL = "demo@supabucks.test"

/** What the demo customer bought, and how many days ago. */
const PURCHASES: Array<{ item: MenuItem | undefined; daysAgo: number }> = [
  { item: MENU[0], daysAgo: 9 },
  { item: MENU[2], daysAgo: 6 },
  { item: MENU[1], daysAgo: 3 },
  { item: MENU[5], daysAgo: 1 },
]

/** What the demo customer spent stars on. */
const REDEMPTIONS: Array<{ reward: Reward | undefined; daysAgo: number }> = [{ reward: REWARDS[0], daysAgo: 2 }]

const CUSTOMER_SQL = `
  insert into customer (id, name, stars, "lifetimeStars")
  select u.id, $2, $3::int, $4::int from auth.users u where u.email = $1
  on conflict (id) do update set stars = excluded.stars, "lifetimeStars" = excluded."lifetimeStars"`

/** One activity row for the demo account, unless it already has one with this label. */
function activitySql(kind: "earn" | "redeem"): string {
  return `
  insert into activity (auth_user_id, customer_id, kind, label, emoji, stars, amount, created_at)
  select u.id, u.id, '${kind}', $2, $3, $4::int, ${kind === "earn" ? "$6::int" : "null"},
         now() - make_interval(days => $5::int)
  from auth.users u
  where u.email = $1
    and not exists (select 1 from activity a where a.auth_user_id = u.id and a.label = $2)`
}

export default function seed({ db, log }: SeedContext): void {
  log(`seeding the loyalty card of ${DEMO_EMAIL}; nothing is written if that account does not exist`)

  const earned = PURCHASES.reduce((sum, { item }) => sum + (item?.stars ?? 0), 0)
  const spent = REDEMPTIONS.reduce((sum, { reward }) => sum + (reward?.cost ?? 0), 0)
  // The card first: every activity row names it.
  db.$sql(CUSTOMER_SQL, [DEMO_EMAIL, "Demo Customer", earned - spent, earned])

  for (const { item, daysAgo } of PURCHASES) {
    if (item === undefined) continue
    db.$sql(activitySql("earn"), [DEMO_EMAIL, item.label, item.emoji, item.stars, daysAgo, item.amount])
  }
  for (const { reward, daysAgo } of REDEMPTIONS) {
    if (reward === undefined) continue
    db.$sql(activitySql("redeem"), [DEMO_EMAIL, reward.name, reward.emoji, -reward.cost, daysAgo])
  }
}
