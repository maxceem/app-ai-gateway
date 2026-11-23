/**
 * The app a request's handler actually loaded, so a refusal's log line can
 * name it (`../index.ts`). Only an app record the gateway read is named: a
 * path segment that names no registered app is the caller's own text, and is
 * never copied into a log.
 */
const loaded = new WeakMap<Request, string>();

export function noteLoadedApp(request: Request, appId: string): void {
  loaded.set(request, appId);
}

export function loadedAppId(request: Request): string | undefined {
  return loaded.get(request);
}
