// GitHub-only model review. Runs trusted main-branch code; comment text is data.
// publish <scan.json>: refresh the rolling issue after a complete daily scan.
// prepare <PR-body.md>: validate a comment and stage its explicit decisions.
// reply <PR-url>: link the generated PR back to the decision comment.
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  applyDecisions, DECISION_BRANCH, ISSUE_MARKER, parseCommands,
  pendingDecisions, renderDecision, renderIssue,
} from "./models/review.mjs";
import { escape } from "./models/report.mjs";

const CATALOG = fileURLToPath(new URL("../src/usage/models.json", import.meta.url));
const ACKNOWLEDGED = fileURLToPath(new URL("./models/acknowledged.json", import.meta.url));

export function githubClient(repository, token, fetcher = fetch) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? "") || !token) throw new Error("GITHUB_REPOSITORY and GH_TOKEN are required.");
  return async (path, { method = "GET", body } = {}) => {
    const response = await fetcher(`https://api.github.com/repos/${repository}/${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "x-github-api-version": "2026-03-10" },
      ...(body && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`GitHub ${method} ${path} failed (HTTP ${response.status}).`);
    return response.status === 204 ? null : response.json();
  };
}

async function list(api, path) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const rows = await api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    items.push(...rows);
    if (rows.length < 100) return items;
  }
}

export async function publishReview(snapshot, { api, repository }) {
  if (!snapshot.complete) {
    console.log("Review issue kept unchanged: at least one official discovery source failed.");
    return;
  }
  const issues = await list(api, "issues?state=all&creator=github-actions%5Bbot%5D");
  const issue = issues.find((item) => !item.pull_request && item.user?.login === "github-actions[bot]" && item.body?.startsWith(ISSUE_MARKER));
  if (!issue && snapshot.newModels.length === 0) return;
  const pulls = await list(api, "pulls?state=open&base=main");
  const body = renderIssue(snapshot, pendingDecisions(pulls, repository));
  const result = issue
    ? await api(`issues/${issue.number}`, { method: "PATCH", body: { body, state: "open", title: "New model review" } })
    : await api("issues", { method: "POST", body: { title: "New model review", body } });
  console.log(`New model review: ${result.html_url}`);
}

/** Authorize against live GitHub state before parsing commands or reading sources. */
export async function prepareReview(event, {
  api, repository, bodyPath, read = readFile, write = writeFile,
  output = async () => {}, loadPage, today = new Date().toISOString().slice(0, 10),
}) {
  const number = event.issue?.number;
  const commentId = event.comment?.id;
  if (event.action !== "created" || event.issue?.pull_request || !Number.isSafeInteger(number) || !Number.isSafeInteger(commentId)) return;
  const issue = await api(`issues/${number}`);
  if (issue.pull_request || issue.state !== "open" || issue.user?.login !== "github-actions[bot]" || !issue.body?.startsWith(ISSUE_MARKER)) return;
  const comment = await api(`issues/comments/${commentId}`);
  if (comment.user?.id !== event.comment.user?.id || comment.user?.type !== "User") return;
  const permission = await api(`collaborators/${encodeURIComponent(comment.user.login)}/permission`);
  if (!["write", "admin"].includes(permission.permission)) return;
  const respond = (body) => api(`issues/${number}/comments`, { method: "POST", body: { body } });
  try {
    const commands = parseCommands(comment.body);
    const branch = `${DECISION_BRANCH}${commentId}`;
    const pulls = await list(api, "pulls?state=open&base=main");
    const pending = pendingDecisions(pulls.filter((pr) => pr.head?.ref !== branch), repository);
    const text = await read(CATALOG, "utf8");
    const acknowledged = JSON.parse(await read(ACKNOWLEDGED, "utf8"));
    const result = await applyDecisions({ text, acknowledged, commands, pending, today, loadPage });
    const changed = result.text !== text || JSON.stringify(result.acknowledged) !== JSON.stringify(acknowledged);
    if (!changed) {
      await respond("These decisions are already recorded. No new PR is needed.");
      return;
    }
    await write(CATALOG, result.text);
    await write(ACKNOWLEDGED, `${JSON.stringify(result.acknowledged, null, 2)}\n`);
    await write(bodyPath, renderDecision(commands, issue.html_url));
    await output(`ready=true\nbranch=${branch}\n`);
  } catch (error) {
    await respond(`Model decisions were not applied: ${escape(error.message)}\n\nUse one command per line: \`/models add provider/model\` or \`/models skip provider/model reason\`.`);
    throw error;
  }
}

async function main() {
  const [mode, argument] = process.argv.slice(2);
  const repository = process.env.GITHUB_REPOSITORY;
  const api = githubClient(repository, process.env.GH_TOKEN);
  if (mode === "publish") {
    await publishReview(JSON.parse(await readFile(argument, "utf8")), { api, repository });
  } else if (mode === "prepare") {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
    await prepareReview(event, { api, repository, bodyPath: argument, output: (text) => appendFile(process.env.GITHUB_OUTPUT, text) });
  } else if (mode === "reply") {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
    if (!argument?.startsWith(`https://github.com/${repository}/pull/`) || !Number.isSafeInteger(event.issue?.number)) throw new Error("Invalid decision PR URL.");
    await api(`issues/${event.issue.number}/comments`, { method: "POST", body: { body: `Your model decisions are ready in ${argument}. Merge that PR to finalize them; the next daily scan refreshes this issue.` } });
    // The daily scan owns the issue body; this reply supplies the immediate link.
  } else throw new Error("Use publish <scan.json>, prepare <PR-body.md>, or reply <PR-url>.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
