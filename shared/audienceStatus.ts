export type AudienceTransport = "bot" | "mtproto";

/** Counts refer to unique canonical members of this owner's selected local list.
 * unsupported, optedOut, allowed and needsConfirmation partition total in that
 * order: Bot API phone numbers are unsupported even if a permission row exists.
 * identityChanged is a subset of needsConfirmation, never an additional group.
 * These counts describe stored permissions; they do not discover Telegram users
 * or guarantee that Telegram will accept a future delivery.
 */
export type AudienceStatus = {
  listId: number;
  total: number;
  allowed: number;
  needsConfirmation: number;
  identityChanged: number;
  optedOut: number;
  unsupported: number;
};
