// Static catalog data for the demo. Drinks you can "buy" to earn stars, and
// rewards you can redeem them for. (Kept in the app so the demo needs no seed.)

export interface MenuItem {
  label: string
  emoji: string
  /** Price in pence. */
  amount: number
  /** Stars earned. */
  stars: number
}

export interface Reward {
  id: string
  name: string
  emoji: string
  description: string
  /** Stars required to redeem. */
  cost: number
}

export const MENU: MenuItem[] = [
  { label: "Pike Place Roast", emoji: "☕", amount: 295, stars: 10 },
  { label: "Caffè Latte", emoji: "🥛", amount: 425, stars: 15 },
  { label: "Caramel Macchiato", emoji: "🍮", amount: 495, stars: 20 },
  { label: "Cold Brew", emoji: "🧊", amount: 445, stars: 18 },
  { label: "Matcha Latte", emoji: "🍵", amount: 475, stars: 19 },
  { label: "Butter Croissant", emoji: "🥐", amount: 345, stars: 12 },
]

export const REWARDS: Reward[] = [
  { id: "brew", name: "Freshly Brewed Coffee", emoji: "☕", description: "Any size hot or iced brewed coffee.", cost: 50 },
  { id: "latte", name: "Handcrafted Drink", emoji: "🥛", description: "Any handcrafted espresso drink, any size.", cost: 150 },
  { id: "bakery", name: "Bakery Treat", emoji: "🥐", description: "A warm croissant, muffin or cookie.", cost: 200 },
  { id: "frapp", name: "Signature Frappé", emoji: "🧋", description: "Any blended Frappé, any size.", cost: 300 },
  { id: "tumbler", name: "Supabucks Tumbler", emoji: "🥤", description: "Limited-edition reusable tumbler.", cost: 450 },
]

/** Lifetime stars needed for Gold tier. */
export const GOLD_THRESHOLD = 300

export type Tier = "green" | "gold"

export function tierFor(lifetimeStars: number): Tier {
  return lifetimeStars >= GOLD_THRESHOLD ? "gold" : "green"
}

/** The next reward the customer can almost afford — drives the progress bar. */
export function nextReward(stars: number): Reward | null {
  return REWARDS.find((r) => r.cost > stars) ?? null
}
