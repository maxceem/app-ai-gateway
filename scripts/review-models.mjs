// Runs main-branch code only. A PR's fixed review JSON is data, never code.
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { modelKey, REVIEW_BRANCH, REVIEW_PATH, validateChoices } from "./models/choices.mjs";
import { escape } from "./models/report.mjs";
import { parseCommands } from "./models/review.mjs";

export function githubClient(repository, token, fetcher = fetch) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? "") || !token) throw new Error("GITHUB_REPOSITORY and GH_TOKEN are required.");
  return async (path, { method = "GET", body } = {}) => {
    const response = await fetcher(`https://api.github.com/repos/${repository}/${path}`, {
      method, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "x-github-api-version": "2026-03-10" },
      ...(body && { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw Object.assign(new Error(`GitHub ${method} ${path} failed (HTTP ${response.status}).`), { status: response.status });
    return response.status === 204 ? null : response.json();
  };
}

export function trustedPull(pr, repository) {
  return pr?.state === "open" && pr.user?.login === "github-actions[bot]" && pr.base?.ref === "main" &&
    pr.head?.ref === REVIEW_BRANCH && pr.head?.repo?.full_name === repository && /^[a-f0-9]{40}$/u.test(pr.head?.sha ?? "");
}

export async function readReview(pr, { api, repository }) {
  if (!trustedPull(pr, repository)) throw new Error("This is not the rolling model catalog PR.");
  let file;
  try { file = await api(`contents/${REVIEW_PATH}?ref=${pr.head.sha}`); }
  catch (error) { if (error.status === 404) return []; throw error; }
  if (file.encoding !== "base64" || typeof file.content !== "string" || file.content.length > 1_000_000) throw new Error("Invalid PR review file.");
  return validateChoices(JSON.parse(Buffer.from(file.content, "base64").toString("utf8")));
}

export async function loadReview({ api, repository }) {
  const head = encodeURIComponent(`${repository.split("/")[0]}:${REVIEW_BRANCH}`);
  for (let page = 1; ; page += 1) {
    const pulls = await api(`pulls?state=open&base=main&head=${head}&per_page=100&page=${page}`);
    const pr = pulls.find((item) => trustedPull(item, repository));
    if (pr) return readReview(pr, { api, repository });
    if (pulls.length < 100) return [];
  }
}

/** Live permission checks precede reading choices, writing data or replying. */
export async function prepareReview(event, { api, repository, reviewPath, overridesPath, write = writeFile, output = async () => {} }) {
  const number = event.issue?.number;
  const commentId = event.comment?.id;
  if (event.action !== "created" || !event.issue?.pull_request || !Number.isSafeInteger(number) || !Number.isSafeInteger(commentId)) return;
  const pr = await api(`pulls/${number}`);
  if (!trustedPull(pr, repository)) return;
  const comment = await api(`issues/comments/${commentId}`);
  if (comment.user?.id !== event.comment.user?.id || comment.user?.type !== "User") return;
  const permission = await api(`collaborators/${encodeURIComponent(comment.user.login)}/permission`);
  if (!["write", "admin"].includes(permission.permission)) return;
  try {
    const commands = parseCommands(comment.body);
    const previous = await readReview(pr, { api, repository });
    const ids = new Set(previous.map(modelKey));
    const overrides = validateChoices(commands.map(({ action, provider, model, reason }) => {
      if (!ids.has(`${provider}/${model}`)) throw new Error(`${provider}/${model} has no proposal in this PR.`);
      return { provider, model, action, reason: reason ?? "Added by manual review.", origin: "manual", reviewer: comment.user.login };
    }));
    await write(reviewPath, `${JSON.stringify(previous, null, 2)}\n`);
    await write(overridesPath, `${JSON.stringify(overrides, null, 2)}\n`);
    await output("ready=true\n");
  } catch (error) {
    await api(`issues/${number}/comments`, { method: "POST", body: { body: `Overrides were not applied: ${escape(error.message)}\n\nUse one command per line: \`/models add provider/model\` or \`/models skip provider/model reason\`.` } });
    throw error;
  }
}

async function main() {
  const [mode, first, second] = process.argv.slice(2);
  const repository = process.env.GITHUB_REPOSITORY;
  const api = githubClient(repository, process.env.GH_TOKEN);
  if (mode === "load") {
    await writeFile(first, `${JSON.stringify(await loadReview({ api, repository }), null, 2)}\n`);
  } else if (mode === "prepare") {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
    await prepareReview(event, { api, repository, reviewPath: first, overridesPath: second, output: (text) => appendFile(process.env.GITHUB_OUTPUT, text) });
  } else if (mode === "reply" || mode === "failed") {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
    const number = event.issue?.number;
    if (!Number.isSafeInteger(number) || !event.issue?.pull_request || !trustedPull(await api(`pulls/${number}`), repository)) throw new Error("Invalid model review PR.");
    const body = mode === "reply"
      ? "Updated this PR with your overrides. Later runs preserve these choices; merge the PR to apply the proposed additions and skips."
      : `Overrides were not applied. See the [workflow run](https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}) for the validation error.`;
    await api(`issues/${number}/comments`, { method: "POST", body: { body } });
  } else throw new Error("Use load <review.json>, prepare <review.json> <overrides.json>, reply, or failed.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
