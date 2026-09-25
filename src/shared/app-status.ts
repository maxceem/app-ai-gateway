/**
 * Every status an application can be in: serving, or paused by its owner.
 * Written once; the column, the Worker's record and the contracts all read it.
 */
export const APP_STATUSES = ["active", "disabled"] as const;

export type AppStatus = (typeof APP_STATUSES)[number];

export function isAppStatus(value: string): value is AppStatus {
  return APP_STATUSES.some((status) => status === value);
}
