import type { Choice } from "@/components/choice-list";
import { DEFAULT_END_USER_HEADER } from "@/lib/config-types";

/**
 * How the application's end users are identified: the value the config stores,
 * with `none` standing for the absent block an api_key app may have.
 */
export type UserSource = "none" | "header" | "issuer" | "app_install";

/*
 * The answers to "who may call?", worded for the person deciding rather than
 * for the config. Most secure first, on both lists, so the safest answer is
 * the one read first. The creation wizard and the Access tab ask the same
 * question, so they share the same answers.
 */
export const IOS_USER_CHOICES: Choice<UserSource>[] = [
  {
    value: "issuer",
    label: "Signed-in users only",
    description: "Users sign in through your identity provider, and the gateway verifies it.",
  },
  {
    value: "app_install",
    label: "Unauthenticated users",
    description: "Anyone with your app can call. Each installation counts as one user.",
  },
];

export const SERVER_USER_CHOICES: Choice<UserSource>[] = [
  {
    value: "issuer",
    label: "Signed-in users only",
    description: "Your backend forwards each user's sign-in token, and the gateway verifies it.",
  },
  {
    value: "header",
    label: "Your backend sends the user id",
    description: `In the ${DEFAULT_END_USER_HEADER} header on every request.`,
  },
  {
    value: "none",
    label: "No user identity",
    description: "Requests are not linked to any user.",
  },
];
