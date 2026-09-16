// Protected first initialization for a checkout deployed without `agw deployment setup`.
import { randomBytes } from "node:crypto";
import {
  constants,
  mkdirSync,
  lstatSync,
  fstatSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  fsyncSync,
  linkSync,
  unlinkSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

class InitializationError extends Error {}
const fail = (message) => {
  throw new InitializationError(message);
};
const proof = /^[A-Za-z0-9_-]{32,256}$/;
const privateFile = (info) =>
  info.isFile() && !(info.mode & 0o077) && (!process.getuid || info.uid === process.getuid());
function readPrivate(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!privateFile(fstatSync(fd)) || lstatSync(path).isSymbolicLink()) {
      fail("Initialization files must be regular files owned by you with mode 0600.");
    }
    return readFileSync(fd, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
function syncDirectory(directory) {
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function publishPrivate(directory, path, value) {
  const temporary = join(directory, `.pending-${randomBytes(16).toString("hex")}`);
  let fd;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, value);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // Linking a complete, synced inode publishes it atomically and cannot
    // replace an output another process created while the HTTP call ran.
    linkSync(temporary, path);
    syncDirectory(directory);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {}
  }
}
function validCredential(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 16384 &&
    !/[\r\n\0]/.test(value.trim())
  );
}

export async function bootstrapAccount({
  url,
  directory = ".agw-bootstrap",
  fetchImpl = fetch,
}) {
  let lock;
  let lockFile;
  try {
    const target = new URL(url);
    if (
      (target.protocol !== "https:" &&
        !(
          target.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)
        )) ||
      target.username ||
      target.password ||
      target.pathname !== "/" ||
      target.search ||
      target.hash
    )
      fail("Use an HTTPS gateway origin (HTTP is allowed on localhost).");
    directory = resolve(directory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.mode & 0o077 ||
      (process.getuid && info.uid !== process.getuid())
    ) {
      fail("Initialization state must be a real directory owned by you with mode 0700.");
    }
    lockFile = join(directory, "initialization.lock");
    try {
      lock = openSync(lockFile, "wx", 0o600);
    } catch (error) {
      if (error.code === "EEXIST")
        fail(
          "Initialization is locked. Wait for the other process; after a crash, verify the PID in initialization.lock before removing it.",
        );
      throw error;
    }
    writeFileSync(lock, JSON.stringify({ pid: process.pid }));
    fsyncSync(lock);
    const stateFile = join(directory, "state.json"),
      keyFile = join(directory, "management-key");
    const request = async (path, init = {}) => {
      try {
        const response = await fetchImpl(`${target.origin}${path}`, {
          ...init,
          redirect: "error",
          signal: AbortSignal.timeout(30000),
        });
        if (!response.ok)
          fail(
            `Gateway initialization failed (HTTP ${response.status}); retry with the same saved state.`,
          );
        return await response.json();
      } catch (error) {
        if (error instanceof InitializationError) throw error;
        fail(
          "Gateway initialization could not complete. Check connectivity and retry with the same saved state.",
        );
      }
    };
    const capabilities = await request("/v1/cli/capabilities");
    if (
      capabilities.deployment?.mode !== "self_hosted" ||
      typeof capabilities.deployment.id !== "string" ||
      !capabilities.deployment.id
    ) {
      fail("This helper initializes a self-hosted deployment only.");
    }
    let state;
    const saved = readPrivate(stateFile);
    if (saved !== undefined) {
      try {
        state = JSON.parse(saved);
      } catch {
        fail(
          "Initialization state is malformed; restore it from a private backup before retrying.",
        );
      }
      if (!state || typeof state.idempotencyKey !== "string" || typeof state.pollToken !== "string" || !proof.test(state.idempotencyKey) || !proof.test(state.pollToken))
        fail(
          "Initialization state is malformed; restore it from a private backup before retrying.",
        );
      if (state.origin !== target.origin || state.deploymentId !== capabilities.deployment.id)
        fail(
          "Saved initialization belongs to a different deployment. Use a separate state directory.",
        );
    } else {
      state = {
        origin: target.origin,
        deploymentId: capabilities.deployment.id,
        idempotencyKey: randomBytes(32).toString("base64url"),
        pollToken: randomBytes(32).toString("base64url"),
      };
      publishPrivate(directory, stateFile, JSON.stringify(state));
    }
    const existing = readPrivate(keyFile);
    if (existing !== undefined) {
      if (!validCredential(existing))
        fail(
          "The saved management credential is empty or malformed. Preserve state.json and move the invalid credential aside before retrying.",
        );
      return { keyFile, recovered: true };
    }
    const result = await request("/v1/cli/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idempotencyKey: state.idempotencyKey, pollToken: state.pollToken }),
    });
    if (result.deployment?.id !== state.deploymentId || !validCredential(result.credential?.token))
      fail(
        "The initialization response did not match the deployment or contained no usable credential.",
      );
    publishPrivate(directory, keyFile, `${result.credential.token.trim()}\n`);
    return { keyFile, recovered: false };
  } catch (error) {
    if (error instanceof InitializationError) throw error;
    throw new InitializationError(
      "Initialization could not complete safely. Preserve its private state and retry; existing files were not overwritten.",
    );
  } finally {
    if (lock !== undefined) {
      closeSync(lock);
      unlinkSync(lockFile);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [url, ...flags] = process.argv.slice(2);
    if (!url || flags.length > 0) fail("Usage: node scripts/bootstrap-account.mjs <gateway-origin>");
    const result = await bootstrapAccount({ url });
    console.log(`Management credential saved privately to ${result.keyFile}.`);
    console.log(
      "Connect with agw deployment connect --url <gateway-origin> --key-stdin < <credential-file>, then run agw account claim.",
    );
  } catch (error) {
    console.error(
      error instanceof InitializationError
        ? error.message
        : "Initialization failed; preserve its private state and check the supplied input.",
    );
    process.exitCode = 1;
  }
}
