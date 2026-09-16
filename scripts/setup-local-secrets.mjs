import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const path = ".dev.vars";
let contents = existsSync(path) ? readFileSync(path, "utf8") : readFileSync(".dev.vars.example", "utf8");

function currentValue(name) {
  return new RegExp(`^${name}=(.*)$`, "mu").exec(contents)?.[1]?.trim();
}

function hasUsableValue(name) {
  const value = currentValue(name);
  return Boolean(value && !value.startsWith("replace-with-"));
}

function setValue(name, value) {
  const pattern = new RegExp(`^${name}=.*$`, "mu");
  if (pattern.test(contents)) {
    contents = contents.replace(pattern, `${name}=${value}`);
  } else {
    contents = `${contents.trimEnd()}\n${name}=${value}\n`;
  }
}

const generated = [];
if (!hasUsableValue("JWT_SECRET")) {
  setValue("JWT_SECRET", randomBytes(48).toString("base64url"));
  generated.push("JWT_SECRET");
}
if (!hasUsableValue("BETTER_AUTH_SECRET")) {
  setValue("BETTER_AUTH_SECRET", randomBytes(48).toString("base64url"));
  generated.push("BETTER_AUTH_SECRET");
}

if (!hasUsableValue("DEPLOYMENT_ID")) {
  setValue("DEPLOYMENT_ID", randomUUID());
  generated.push("DEPLOYMENT_ID");
}
writeFileSync(path, contents, { mode: 0o600 });
chmodSync(path, 0o600);

if (generated.length === 0) {
  console.log(".dev.vars already contains the internal signing secrets and deployment initialization values; nothing changed.");
} else {
  console.log(`Generated ${generated.join(" and ")} in .dev.vars.`);
}
