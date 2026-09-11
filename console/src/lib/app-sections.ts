import {
  BadgeCheck,
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
  icon: typeof BadgeCheck;
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
  { slug: "overview", label: "Overview", icon: BadgeCheck },
  { slug: "auth", label: "Auth policy", icon: ShieldCheck },
  { slug: "proxy", label: "Proxy policy", icon: Waypoints },
  { slug: "endpoints", label: "Endpoints", icon: Route },
  { slug: "limits", label: "Limits", icon: Gauge },
  { slug: "users", label: "Users", icon: Users },
  { slug: "usage", label: "Usage", icon: ChartNoAxesColumn },
  // Next to Usage because it answers the other half of "what happened": one
  // counts the requests that got through, the other the ones that did not.
  { slug: "auth-events", label: "Auth & Errors", icon: ShieldAlert },
  // Last, and apart: name, on or off, and delete are about the app as a record,
  // not about how it works, and nothing here is needed to get traffic flowing.
  { slug: "settings", label: "Settings", icon: Settings },
];

export const DEFAULT_APP_SECTION = APP_SECTIONS[0]!.slug;
