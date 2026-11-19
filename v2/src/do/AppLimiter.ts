/**
 * The app's limiter object (plan section 4.2, admission step 2): one per app,
 * holding the limits the customer set on the app as a whole, requests per
 * minute and per day and a monthly dollar budget (`./request-limits.ts`).
 * The per-app session cap comes with live sessions.
 */
import { RequestLimitObject } from "./request-limits.ts";

export class AppLimiter extends RequestLimitObject {}
