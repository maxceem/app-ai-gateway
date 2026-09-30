import {
  ArrowLeftRight,
  ChartNoAxesColumn,
  Gauge,
  Route,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Users,
  Waypoints,
} from "lucide-react";

export interface AppSection {
  slug: string;
  label: string;
  icon: typeof ShieldCheck;
  /** The line under the page's title, where one sentence says what the list is. */
  description?: string;
}

/**
 * The sections of one app. They live here rather than in the detail page
 * because the sidebar is what lists them: opening an app hands the rail over
 * to that app, and these are the rows it shows.
 *
 * The order reads the configuration down, then what it produced, then the
 * record itself.
 */
export const APP_SECTIONS: AppSection[] = [
  { slug: "auth", label: "Auth policy", icon: ShieldCheck },
  // One page per thing an app's proxy policy decides, so each page is one list:
  // the providers it may call, the model names it maps, the endpoints it names.
  { slug: "providers", label: "Provider access", icon: Waypoints },
  {
    slug: "rewrites",
    label: "Model rewrites",
    icon: ArrowLeftRight,
    description: "When the app asks for one model, use another instead.",
  },
  {
    slug: "custom-endpoints",
    label: "Custom endpoints",
    icon: Route,
    description: "Your custom endpoints that call real provider endpoints underneath.",
  },
  { slug: "limits", label: "Limits", icon: Gauge },
  { slug: "users", label: "Users", icon: Users },
  { slug: "usage", label: "Usage", icon: ChartNoAxesColumn },
  // Next to Usage because it answers the other half of "what happened": one
  // counts the requests that got through, the other the ones that did not.
  //
  // Named for what an operator comes here to find rather than for the table it
  // mostly reads. Most of these failures are authentication refusals, but the
  // page folds refused proxied requests in beside them, and nobody opens it
  // except to ask why something did not work.
  { slug: "errors", label: "Errors", icon: ShieldAlert },
  // Last, and apart: name, on or off, and delete are about the app as a record,
  // not about how it works, and nothing here is needed to get traffic flowing.
  { slug: "settings", label: "Settings", icon: Settings },
];

export const DEFAULT_APP_SECTION = APP_SECTIONS[0]!.slug;

/**
 * Slugs a section used to have, so a bookmark from before the rename still
 * opens the page it meant rather than the default one.
 */
export const RENAMED_APP_SECTIONS: Record<string, string> = {
  proxy: "providers",
  endpoints: "custom-endpoints",
};
