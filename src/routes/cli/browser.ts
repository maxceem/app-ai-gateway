import { completeProviderSubmission } from "./provider-handoff";
import { cliJson } from "./security";
import { GatewayError } from "../../core/errors";
import { enforceEndpointRateLimit } from "../../core/endpoint-rate-limit";
import { CliSubmissionRequestSchema } from "../../contracts/cli";
import { providerSchemaBody } from "../admin/provider-shared";
import {
  accountLifecycle,
  assertAccountAccess,
} from "../../core/account-lifecycle";
import {
  createClaimRegistrationAuth,
  googleAuthEnabled,
} from "../../auth/identity";
import { deployment } from "./bootstrap";
import { authState, challenge } from "./operations";
import { completeIdentity } from "./identity-handoff";
import { proofMatches } from "./security";
import type { CliContext } from "./types";

export async function verifiedSubmission(c: CliContext) {
  const meta = deployment(c);
  if (new URL(c.req.url).origin !== meta.consoleOrigin)
    throw new GatewayError(404, "not_found", "Page was not found");
  if (c.req.header("origin") !== meta.consoleOrigin)
    throw new GatewayError(
      403,
      "forbidden",
      "Use the first-party approval page",
    );
  const input = providerSchemaBody(
    CliSubmissionRequestSchema,
    await cliJson(c.req.raw),
  );
  const row = await challenge(c);
  await enforceEndpointRateLimit(c.env, `submission:${row.id}`, 10, 60_000);
  if (row.expires_at <= Date.now())
    throw new GatewayError(410, "invalid_request", "Operation has expired");
  if (!(await proofMatches(input.submissionToken, row.submission_proof_hash)))
    throw new GatewayError(403, "forbidden", "Invalid submission proof");
  await assertAccountAccess(c.env, row.organization_id, row.kind === "claim" ? "claim" : "read");
  return { input, row };
}
export async function browserDetails(c: CliContext): Promise<Response> {
  const { row } = await verifiedSubmission(c);
  const state = await authState(c, true);
  const visiblePayload = JSON.parse(row.request_json) as Record<string, unknown>;
  for (const field of [
    "__requestHash",
    "expectedUpdatedAt",
    "expectedGatewayUpdatedAt",
  ])
    delete visiblePayload[field];
  return c.json({
    kind: row.kind,
    payload: visiblePayload,
    account: await accountLifecycle(c.env, row.organization_id),
    signedIn: state.assurance === "interactive",
    googleEnabled: googleAuthEnabled(c.env),
    expiresAt: new Date(row.expires_at).toISOString(),
  });
}
export async function browserRegister(c: CliContext): Promise<Response> {
  const { row, input } = await verifiedSubmission(c);
  if (row.kind !== "claim" || row.consumed_at)
    throw new GatewayError(
      403,
      "forbidden",
      "Registration is only available for a pending account claim",
    );
  if (!input.email || !input.password || !input.name)
    throw new GatewayError(
      400,
      "invalid_request",
      "Name, email and password are required",
    );
  const response = await createClaimRegistrationAuth(
    c.env,
    c.req.url,
  ).auth.api.signUpEmail({
    body: { email: input.email, password: input.password, name: input.name },
    headers: c.req.raw.headers,
    asResponse: true,
  });
  return response;
}

export async function browserSubmit(c: CliContext): Promise<Response> {
  const { row, input } = await verifiedSubmission(c);
  if (input.approve !== true)
    throw new GatewayError(
      400,
      "invalid_request",
      "Explicit approval is required",
    );
  if (row.kind === "claim") {
    if (typeof input.allowServiceAccess !== "boolean")
      throw new GatewayError(
        400,
        "invalid_request",
        "Choose whether to allow ongoing CLI access",
      );
    await completeIdentity(c, row, input.allowServiceAccess);
  } else {
    await completeProviderSubmission(c, row, input.secret);
  }
  return c.json({
    state: "completed",
    message: "Approved. Return to your CLI.",
  });
}

/** Static first-party form: no third-party scripts, analytics, or credential URLs. */
export function browserPage(c: CliContext): Response {
  const meta = deployment(c);
  if (new URL(c.req.url).origin !== meta.consoleOrigin)
    throw new GatewayError(404, "not_found", "Page was not found");
  const nonce = crypto.randomUUID().replaceAll("-", "");
  c.header(
    "Content-Security-Policy",
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
  );
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  return c.html(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Approve CLI request · App AI Gateway</title>
<style nonce="${nonce}">:root{color-scheme:light;font-family:Georgia,serif;color:#17251e;background:#f3f3eb}body{max-width:640px;margin:7vh auto;padding:24px}header{font:13px ui-monospace,monospace;letter-spacing:.12em;color:#48634c}h1{font-weight:400;font-size:40px;line-height:1.1;margin:20px 0}section{background:#fff;padding:28px;border:1px solid #d4dacf;border-radius:8px;margin:20px 0}label{display:block;margin:18px 0 6px}input,select,button{font:16px ui-sans-serif,sans-serif;border:1px solid #9aa89c;border-radius:5px;padding:12px;box-sizing:border-box;width:100%}button{background:#244e38;color:white;margin-top:22px;cursor:pointer}button:disabled{opacity:.5;cursor:wait}input[type=checkbox]{width:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}#status{font-family:ui-sans-serif,sans-serif;line-height:1.5}small{font-family:ui-sans-serif,sans-serif;line-height:1.5}</style>
<header>APP AI GATEWAY / CLI APPROVAL</header><h1>Review the request.</h1><p>Compare the account and action below with your CLI before approving.</p><section><pre id="details">Loading protected request…</pre><form id="signin" hidden><h2>Sign in</h2><label for="email">Email</label><input id="email" type="email" autocomplete="username"><label for="password">Password</label><input id="password" type="password" autocomplete="current-password"><button>Sign in</button><div id="registration" hidden><label for="name">Name for your account</label><input id="name" autocomplete="name"><button type="button" id="register">Create your login</button></div><button type="button" id="google" hidden>Continue with Google</button></form><form id="approve" hidden><label for="secret" id="secretLabel" hidden>Provider credential</label><input id="secret" type="password" autocomplete="off" hidden><label><input id="confirm" type="checkbox" required> I approve this action for the account shown above.</label><label id="ongoingLabel"><input id="ongoing" type="checkbox" checked> Keep this service identity and its role-based management access.</label><button>Approve request</button></form></section><p id="status" role="status"></p><small>This page never displays management credentials. Provider credentials are submitted directly to your gateway.</small>
<script nonce="${nonce}">let saved=null;try{saved=JSON.parse(sessionStorage.getItem(location.pathname)||'null')}catch{}if(saved&&saved.expiresAt<=Date.now()){sessionStorage.removeItem(location.pathname);saved=null}const token=location.hash.slice(1)||saved?.token||'';history.replaceState(null,'',location.pathname);const base=location.pathname;const details=document.getElementById('details'),status=document.getElementById('status');let current;
async function call(path,body){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Error(data.error?.message||data.message||'Request failed');return data}
async function load(){current=await call(base+'/details',{submissionToken:token});sessionStorage.setItem(base,JSON.stringify({token,expiresAt:Date.parse(current.expiresAt)}));details.textContent=JSON.stringify({action:current.kind,account:current.account,configuration:current.payload,expiresAt:current.expiresAt},null,2);const identity=current.kind==='claim';document.getElementById('signin').hidden=!identity||current.signedIn;document.getElementById('registration').hidden=!identity;document.getElementById('google').hidden=!current.googleEnabled;document.getElementById('approve').hidden=identity&&!current.signedIn;const needsSecret=!identity&&!(current.kind==='provider.add'&&current.payload.providerGatewayId);document.getElementById('secret').hidden=!needsSecret;document.getElementById('secret').required=needsSecret;document.getElementById('secretLabel').hidden=!needsSecret;document.getElementById('ongoingLabel').hidden=!identity;}
document.getElementById('signin').onsubmit=async e=>{e.preventDefault();try{await call('/v1/auth/sign-in/email',{email:document.getElementById('email').value,password:document.getElementById('password').value});document.getElementById('password').value='';await load()}catch(e){status.textContent=e.message}};
document.getElementById('register').onclick=async()=>{try{await call(base+'/register',{submissionToken:token,email:document.getElementById('email').value,password:document.getElementById('password').value,name:document.getElementById('name').value});document.getElementById('password').value='';await load()}catch(e){status.textContent=e.message}};
document.getElementById('google').onclick=async()=>{try{const result=await call(current.kind==='claim'?base+'/google':'/v1/auth/sign-in/social',current.kind==='claim'?{submissionToken:token}:{provider:'google',callbackURL:location.href});location.href=result.url}catch(e){status.textContent=e.message}};
document.getElementById('approve').onsubmit=async e=>{e.preventDefault();const b=e.target.querySelector('button');b.disabled=true;try{const value={submissionToken:token,approve:true,allowServiceAccess:document.getElementById('ongoing').checked};if(!document.getElementById('secret').hidden)value.secret=document.getElementById('secret').value;await call(base+'/submit',value);document.getElementById('secret').value='';status.textContent='Approved. Return to your CLI.';sessionStorage.removeItem(base);e.target.hidden=true}catch(e){status.textContent=e.message;b.disabled=false}};load().catch(e=>status.textContent=e.message);</script></html>`);
}
