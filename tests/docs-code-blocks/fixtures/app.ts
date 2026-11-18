/**
 * The reader's own app code that an example calls but does not show, imported as `./app`: what a
 * page does with a bid or a refusal is the reader's business, not ours. Each is typed as loosely as
 * any app could write it, so the check still fails on a Supatype API that does not exist.
 */
export const lotId = "lot-1"
export const displayName = "Ada"

export function addBid(bid: unknown): void {
  void bid
}
export function showBid(bid: unknown): void {
  void bid
}
export function notify(payload: unknown): void {
  void payload
}
export function updateWatchers(joins: unknown, leaves: unknown): void {
  void joins
  void leaves
}
export function tellUser(message: string): void {
  void message
}
export function retryLater(): void {}
export function showRefusal(reason: string): void {
  void reason
}
