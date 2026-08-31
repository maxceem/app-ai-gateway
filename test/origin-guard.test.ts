import { describe, expect, it } from "vitest";
import {
  checkOperatorBaseUrl,
  MAX_BASE_URL_LENGTH,
} from "../src/core/origin-guard";

/**
 * The security tests for Stage 6. Everything the guard accepts becomes an
 * origin this Worker will send an organization's provider key to, so the table
 * below is the specification: an entry moving from `rejected` to `accepted`
 * must be a deliberate change, never an accident of refactoring.
 */

/**
 * A base URL of exactly `MAX_BASE_URL_LENGTH + extra` characters. The padding
 * goes in the path: a DNS label caps at 63 characters, so a host long enough to
 * reach the cap would be refused by the label rule instead and prove nothing
 * about the length rule.
 */
function atLengthCap(extra: number): string {
  const prefix = "https://api.example.com/";
  return `${prefix}${"a".repeat(MAX_BASE_URL_LENGTH + extra - prefix.length - 1)}/`;
}

interface AcceptedCase {
  name: string;
  input: string;
  /** The canonical form that is stored and later concatenated with a path. */
  expected: string;
}

const ACCEPTED: AcceptedCase[] = [
  {
    name: "a plain https origin gains a trailing slash",
    input: "https://api.example.com",
    expected: "https://api.example.com/",
  },
  {
    name: "an existing trailing slash is kept as-is",
    input: "https://api.example.com/",
    expected: "https://api.example.com/",
  },
  {
    name: "a base path is preserved and terminated",
    input: "https://my-vllm.example.com/v1",
    expected: "https://my-vllm.example.com/v1/",
  },
  {
    name: "an Azure-style multi-segment base path survives",
    input: "https://my-resource.openai.azure.com/openai/v1/",
    expected: "https://my-resource.openai.azure.com/openai/v1/",
  },
  {
    name: "the host is lower-cased",
    input: "https://VLLM.Example.COM/v1/",
    expected: "https://vllm.example.com/v1/",
  },
  {
    name: "surrounding whitespace is trimmed before parsing",
    input: "   https://api.example.com/v1/   ",
    expected: "https://api.example.com/v1/",
  },
  {
    name: "an explicit default port is normalized away",
    input: "https://api.example.com:443/v1",
    expected: "https://api.example.com/v1/",
  },
  {
    name: "dot segments in the path are resolved",
    input: "https://api.example.com/a/../v1/",
    expected: "https://api.example.com/v1/",
  },
  {
    name: "a unicode host is stored punycoded",
    input: "https://例え.example.com/v1/",
    expected: "https://xn--r8jz45g.example.com/v1/",
  },
  {
    name: "a hyphenated multi-label host is fine",
    input: "https://ark.eu-west.bytepluses.com/api/v3",
    expected: "https://ark.eu-west.bytepluses.com/api/v3/",
  },
  {
    name: "a base URL exactly at the length cap is accepted",
    input: atLengthCap(0),
    expected: atLengthCap(0),
  },
];

interface RejectedCase {
  name: string;
  input: string;
  /** A fragment of the refusal, so the operator is told which rule they broke. */
  because: RegExp;
}

const REJECTED: RejectedCase[] = [
  { name: "http", input: "http://api.example.com/", because: /https/u },
  { name: "a non-web scheme", input: "ftp://api.example.com/", because: /https/u },
  { name: "a scheme-relative URL", input: "//api.example.com/", because: /absolute/u },
  { name: "a bare hostname", input: "api.example.com", because: /absolute/u },
  { name: "an empty value", input: "   ", because: /empty/u },

  {
    name: "credentials in the URL",
    input: "https://user:pass@api.example.com/",
    because: /credentials/u,
  },
  {
    name: "a bare username",
    input: "https://user@api.example.com/",
    because: /credentials/u,
  },
  { name: "a fragment", input: "https://api.example.com/#frag", because: /fragment/u },
  {
    name: "a query string",
    input: "https://api.example.com/?api-version=2024-10-21",
    because: /query/u,
  },
  { name: "an empty query string", input: "https://api.example.com/?", because: /query/u },

  { name: "an IPv4 literal", input: "https://127.0.0.1/", because: /IP address/u },
  { name: "a private IPv4 literal", input: "https://10.0.0.1/", because: /IP address/u },
  { name: "the link-local metadata address", input: "https://169.254.169.254/", because: /IP address/u },
  { name: "a hex-encoded IPv4 literal", input: "https://0x7f000001/", because: /IP address/u },
  { name: "an integer-encoded IPv4 literal", input: "https://2130706433/", because: /IP address/u },
  { name: "an octal-encoded IPv4 literal", input: "https://0177.0.0.1/", because: /IP address/u },
  { name: "an IPv6 loopback literal", input: "https://[::1]/", because: /IPv6/u },
  { name: "a unique-local IPv6 literal", input: "https://[fd00::1]/", because: /IPv6/u },

  { name: "localhost", input: "https://localhost/", because: /domain name|reserved/u },
  { name: "a single-label host", input: "https://vllm/", because: /domain suffix/u },
  { name: "a .local name", input: "https://vllm.local/", because: /reserved local name/u },
  { name: "an .internal name", input: "https://vllm.internal/", because: /reserved local name/u },
  { name: "a .localhost name", input: "https://api.localhost/", because: /reserved local name/u },
  { name: "a home.arpa name", input: "https://router.home.arpa/", because: /reserved local name/u },
  { name: "a trailing dot", input: "https://api.example.com./", because: /end with a dot/u },
  { name: "an empty label", input: "https://a..b.example.com/", because: /invalid DNS label/u },
  { name: "a leading-hyphen label", input: "https://-bad.example.com/", because: /invalid DNS label/u },
  { name: "an underscore in the host", input: "https://api_x.example.com/", because: /invalid DNS label/u },

  {
    name: "a non-default port",
    input: "https://api.example.com:8443/v1/",
    because: /default https port/u,
  },
  { name: "port 80", input: "https://api.example.com:80/", because: /default https port/u },

  {
    name: "a value one character over the length cap",
    input: atLengthCap(1),
    because: /at most/u,
  },
  {
    name: "a DNS label longer than 63 characters",
    input: `https://${"a".repeat(64)}.example.com/`,
    because: /invalid DNS label/u,
  },

  {
    name: "a backslash, which the URL parser would read as a path separator",
    input: "https:\\\\api.example.com\\v1\\",
    because: /backslashes/u,
  },
  {
    name: "an embedded newline, which the URL parser would silently strip",
    input: "https://api.exa\nmple.com/",
    because: /whitespace/u,
  },
  {
    name: "an embedded tab, which the URL parser would silently strip",
    input: "https://api.exa\tmple.com/",
    because: /whitespace/u,
  },
];

describe("operator base-URL origin guard", () => {
  for (const testCase of ACCEPTED) {
    it(`accepts and canonicalizes: ${testCase.name}`, () => {
      const result = checkOperatorBaseUrl(testCase.input);
      expect(result, `expected ${testCase.input} to be accepted`).toMatchObject({ ok: true });
      expect(result.ok && result.baseUrl).toBe(testCase.expected);
    });
  }

  for (const testCase of REJECTED) {
    it(`rejects ${testCase.name}`, () => {
      const result = checkOperatorBaseUrl(testCase.input);
      expect(result.ok, `expected ${JSON.stringify(testCase.input)} to be rejected`).toBe(false);
      expect(result.ok ? "" : result.message).toMatch(testCase.because);
    });
  }

  it("is idempotent: canonicalizing a canonical value changes nothing", () => {
    for (const testCase of ACCEPTED) {
      const once = checkOperatorBaseUrl(testCase.input);
      expect(once.ok).toBe(true);
      const twice = checkOperatorBaseUrl(once.ok ? once.baseUrl : "");
      expect(twice.ok && twice.baseUrl).toBe(testCase.expected);
    }
  });

  it("always produces a base a path can be appended to directly", () => {
    for (const testCase of ACCEPTED) {
      const result = checkOperatorBaseUrl(testCase.input);
      const baseUrl = result.ok ? result.baseUrl : "";
      expect(baseUrl.startsWith("https://")).toBe(true);
      expect(baseUrl.endsWith("/")).toBe(true);
      // No double slash and no missing slash when a provider path is joined.
      expect(new URL(`${baseUrl}v1/models`).pathname.includes("//")).toBe(false);
    }
  });
});
