/**
 * ElevenLabs agents' setup, checked when an app lists them (plan step 11, 11a). An app that allows
 * `elevenlabs.agent` lists the agents it may start, by id, in its route's `models`: the agent's id is the
 * session's model, locked. Each agent the save newly lists is read from ElevenLabs
 * (`GET v1/convai/agents/{id}`, with the connection's key, through the vault) and must have:
 *
 * - its own auth on (`platform_settings.auth.enable_auth`): otherwise anyone who has the agent's id talks
 *   to it straight at ElevenLabs, past the gateway's checks and limits;
 * - the duration override off (`platform_settings.overrides.conversation_config_override.conversation.
 *   max_duration_seconds`): the agent's own duration is a second cap behind the gateway's. The relay also
 *   refuses the override in the client's first message.
 *
 * Saving is strict (`AGENTS.md`): an agent that fails is refused, and one whose settings can't be read is
 * a `503`, never a guess. Only what the save newly lists is read: an agent listed before was checked
 * when it was. A model not named as an agent (`agent_…`: a voice model, listed for another operation of
 * the route) is not one (`listedByPrefix` in `../providers/elevenlabs.ts`).
 */
import { errorFacts } from "../core/error-facts.ts";
import { GatewayError } from "../core/errors.ts";
import { log } from "../core/log.ts";
import type { AppConfig } from "../contracts/app-config.ts";
import { listedAs } from "../providers/listing.ts";
import { connectionDescription, readConnection, sealedCredentials } from "../providers/connections.ts";
import { sealedUpstreamRequest } from "../providers/route.ts";
import { vault } from "../vault/client.ts";

/** The operation whose models are agents. */
export const AGENT_OPERATION = "elevenlabs.agent";
/** How long reading one agent's settings may take. */
const AGENT_READ_MS = 5_000;

/** Whether a listed model is an agent: an id in ElevenLabs' own form for them, `agent_…`, priced as one. */
export function isAgent(model: string): boolean {
  return listedAs("elevenlabs", model).type === "elevenlabs-agents";
}

/** What an agent's settings say, as ElevenLabs answers them: null when both checks pass. */
export function agentSetupProblem(agent: unknown): "auth_off" | "duration_override_on" | null {
  const settings = typeof agent === "object" && agent !== null ? (agent as { platform_settings?: Record<string, unknown> }).platform_settings : undefined;
  const auth = settings?.auth as { enable_auth?: unknown } | undefined;
  if (auth?.enable_auth !== true) return "auth_off";
  const overrides = settings?.overrides as { conversation_config_override?: { conversation?: { max_duration_seconds?: unknown } } } | undefined;
  if (overrides?.conversation_config_override?.conversation?.max_duration_seconds === true) return "duration_override_on";
  return null;
}

function refused(slug: string, agent: string, message: string): GatewayError {
  return new GatewayError(400, "invalid_request", `config.routing.providers.${slug}.models: ${agent} ${message}`, undefined, { data: { slug, model: agent } });
}

/**
 * Checks every agent the save newly lists (`current`: the app as stored, null for a new app). A route that
 * allows agents must list them: none listed would let any agent of the key through unchecked.
 */
export async function checkAgents(env: Env, accountId: string, config: AppConfig, current: AppConfig | null): Promise<void> {
  for (const [slug, route] of Object.entries(config.routing.providers)) {
    if (!route.operations.includes(AGENT_OPERATION)) continue;
    const before = current?.routing.providers[slug];
    if (route.models === undefined) {
      // Unchanged, it was judged when it was saved.
      if (before !== undefined && before.operations.includes(AGENT_OPERATION) && before.models === undefined) continue;
      throw new GatewayError(400, "invalid_request", `config.routing.providers.${slug}.models: list the agents ${AGENT_OPERATION} may start, by their ids`, undefined, {
        data: { slug },
      });
    }
    const checked = new Set(before?.operations.includes(AGENT_OPERATION) === true ? (before.models ?? []) : []);
    const agents = [...new Set(route.models)].filter((model) => !checked.has(model) && isAgent(model));
    if (agents.length === 0) continue;
    const connection = await readConnection(env, accountId, slug);
    const description = connection === null ? null : connectionDescription(connection);
    // The app's own check has refused a missing connection, and one of another type has no agents.
    if (connection === null || description === null || connection.type !== "elevenlabs") continue;
    if (connection.status === "disabled") throw refused(slug, agents[0]!, "can't be checked: the provider connection is disabled");
    await Promise.all(
      agents.map(async (agent) => {
        let status: number;
        let body: unknown = null;
        try {
          const target = sealedUpstreamRequest(connection, description, {
            hostKey: "main",
            path: `v1/convai/agents/${encodeURIComponent(agent)}`,
            query: "",
            credentials: sealedCredentials(connection),
            client: new Headers(),
            appId: "",
            userId: null,
          });
          const response = await vault(env).call({
            url: target.url,
            method: "GET",
            headers: new Headers(target.headers),
            body: null,
            signal: AbortSignal.timeout(AGENT_READ_MS),
            deadline: Date.now() + AGENT_READ_MS,
            credentials: target.credentials,
          });
          status = response.status;
          if (response.ok) body = await response.json();
          else await response.body?.cancel().catch(() => undefined);
        } catch (error) {
          log("warn", "agent_check_unreachable", { slug, error: errorFacts(error) });
          status = 0;
        }
        if (status === 404) throw refused(slug, agent, "is not an agent this ElevenLabs key can reach");
        if (status === 401 || status === 403) throw refused(slug, agent, "can't be checked: ElevenLabs refused the connection's key for reading agents");
        if (status !== 200) {
          // With split keys on, the connection's key opens only with an app's share, which a save doesn't have.
          log("warn", "agent_check_unavailable", { slug, status });
          throw new GatewayError(503, "service_unavailable", `config.routing.providers.${slug}.models: ${agent}'s settings could not be read from ElevenLabs; try again`);
        }
        const problem = agentSetupProblem(body);
        if (problem === "auth_off") throw refused(slug, agent, "has its own authentication off: turn it on in the agent's security settings, so only the gateway can start it");
        if (problem === "duration_override_on") throw refused(slug, agent, "lets a client override its maximum duration: turn that override off in the agent's security settings");
      }),
    );
  }
}
