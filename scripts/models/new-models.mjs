// Exact, durable decisions about models outside the shipped catalog.
export const notAddedKey = (provider, model) => `${provider}/${model}: not added`;

/** IDs already reported by a merged discovery PR are not new notifications. */
export function discoveryUpdate(newModels, notified) {
  if (!Array.isArray(notified) || !notified.every((item) =>
    typeof item?.provider === "string" && Array.isArray(item.ids) && item.ids.every((id) => typeof id === "string"))) {
    throw new Error("scripts/models/notified.json must be a list of { provider, ids }.");
  }
  const known = new Map();
  for (const { provider, ids } of notified) {
    if (!known.has(provider)) known.set(provider, new Set());
    for (const id of ids) known.get(provider).add(id);
  }
  const notifications = [];
  for (const { provider, ids } of newModels) {
    if (!known.has(provider)) known.set(provider, new Set());
    const fresh = ids.filter((id) => !known.get(provider).has(id));
    if (fresh.length) notifications.push({ provider, ids: fresh });
    for (const id of fresh) known.get(provider).add(id);
  }
  return {
    notifications,
    notified: notifications.length
      ? [...known].map(([provider, ids]) => ({ provider, ids: [...ids] }))
      : notified,
  };
}
