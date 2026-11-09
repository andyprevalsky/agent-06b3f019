/** Private challenge-window intervention classification. */
export function inChallengeWindow(
  createdAt: string | Date,
  issuedAt: string,
  consumedAt: string,
): boolean {
  return (
    new Date(createdAt).getTime() >= Date.parse(issuedAt) &&
    new Date(createdAt).getTime() <= Date.parse(consumedAt)
  );
}
export function userIntervened(
  row: { actor: string; operation: string; createdAt: string | Date },
  issuedAt: string,
  consumedAt: string,
): boolean {
  const reads = new Set([
    "screen.frame",
    "screen.text",
    "screen.bounds",
    "session.state",
    "apps.list",
    "apps.current",
    "tree",
  ]);
  return (
    row.actor === "user" &&
    !reads.has(row.operation) &&
    inChallengeWindow(row.createdAt, issuedAt, consumedAt)
  );
}
