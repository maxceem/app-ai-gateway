import { Hono } from "hono";
import prices from "../../core/prices.json";
import type { AdminVariables } from "../../middleware/admin";
import { appRoutes } from "./apps";
import { developmentCredentialRoutes } from "./development-credentials";
import { keyRoutes } from "./keys";
import { usageRoutes } from "./usage";
import { userRoutes } from "./users";

export const adminRoutes = new Hono<{ Bindings: Env; Variables: AdminVariables }>();

/** Supplies the priced model catalog used by the proxy-policy editor. */
adminRoutes.get("/prices", (c) => c.json({ prices }));

adminRoutes.route("/", appRoutes);
adminRoutes.route("/", developmentCredentialRoutes);
adminRoutes.route("/", keyRoutes);
adminRoutes.route("/", userRoutes);
adminRoutes.route("/", usageRoutes);
