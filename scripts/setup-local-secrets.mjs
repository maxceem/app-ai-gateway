import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

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
if (!hasUsableValue("ADMIN_TOKEN")) {
  const token = `agw_admin_${randomBytes(32).toString("base64url")}`;
  setValue("ADMIN_TOKEN", token);
  generated.push("ADMIN_TOKEN");
  console.log(`ADMIN_TOKEN=${token}`);
}

writeFileSync(path, contents, { mode: 0o600 });

if (generated.length === 0) {
  console.log(".dev.vars already contains JWT_SECRET and ADMIN_TOKEN; nothing changed.");
} else {
  console.log(`Generated ${generated.join(" and ")} in .dev.vars.`);
}
