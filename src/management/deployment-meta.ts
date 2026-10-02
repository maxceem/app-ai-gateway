import type { Deployment } from "../policy/deployment";

/**
 * How a client is told which deployment answered: its public identity, plus
 * the one thing about it a client behaves differently for.
 */
export function deploymentMeta(deployment: Deployment) {
  return { ...deployment.identity(), mode: deployment.mode };
}
