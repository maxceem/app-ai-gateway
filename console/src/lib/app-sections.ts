import {
  BadgeCheck,
  Braces,
  ChartNoAxesColumn,
  Route,
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
 * whole document at the end.
 */
export const APP_SECTIONS: AppSection[] = [
  { slug: "overview", label: "Overview", icon: BadgeCheck },
  { slug: "auth", label: "Auth policy", icon: ShieldCheck },
  { slug: "proxy", label: "Proxy policy", icon: Waypoints },
  { slug: "endpoints", label: "Endpoints", icon: Route },
  { slug: "users", label: "Users", icon: Users },
  { slug: "usage", label: "Usage", icon: ChartNoAxesColumn },
  // Next to Usage because it answers the other half of "what happened": one
  // counts the requests that got through, the other the ones that did not.
  { slug: "auth-events", label: "Auth & Errors", icon: ShieldAlert },
  { slug: "json", label: "Raw JSON", icon: Braces },
];

export const DEFAULT_APP_SECTION = APP_SECTIONS[0]!.slug;
