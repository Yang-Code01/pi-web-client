/**
 * D91: a page is `present` when it is visible and its window has focus; every page reports that over
 * its socket whenever it changes. Presence is not per session and not the same thing as a
 * subscription: the person is in front of *some* page, and that is what decides whether an approval
 * is still worth waiting for (#82) or whether a push would be talking to somebody who is already
 * looking at the screen.
 *
 * The timestamp is the part the sockets cannot give: `present === true` is a flag, so this module
 * keeps the clock that says how long nobody has been in front.
 */
const present = new Set<object>();
/** The moment the last page in front went away; the bridge's own start if none ever was. */
let absentSince = Date.now();

/** One page's own answer to "are you visible and focused". */
export function reportPresence(client: object, active: boolean): void {
  if (active === present.has(client)) return;
  if (active) present.add(client);
  else present.delete(client);
  if (present.size === 0) absentSince = Date.now();
}

/** The page's socket closed: whatever it last reported stops counting. */
export function dropClient(client: object): void {
  if (!present.delete(client)) return;
  if (present.size === 0) absentSince = Date.now();
}

export function anyPresent(): boolean {
  return present.size > 0;
}

/** How long nobody has had a page in front; 0 while somebody does. */
export function absentFor(): number {
  return present.size > 0 ? 0 : Date.now() - absentSince;
}
