/** The multipart scanner that reads a form's few text fields without copying the upload. */
import { describe, expect, it } from "vitest";
import { multipartBoundary, MultipartError, scanMultipart } from "../src/http/multipart.ts";

const B = "XyZ";
const encode = (text: string) => new TextEncoder().encode(text);
const part = (headers: string, body: string) => `--${B}\r\n${headers}\r\n\r\n${body}\r\n`;
const form = (...parts: string[]) => encode(`${parts.join("")}--${B}--\r\n`);
const scan = (bytes: Uint8Array, wanted = ["model", "response_format"]) => scanMultipart(bytes, B, new Set(wanted));

describe("multipart forms", () => {
  it("reads the boundary of a form's content type, quoted or not", () => {
    expect(multipartBoundary("multipart/form-data; boundary=abc")).toBe("abc");
    expect(multipartBoundary('Multipart/Form-Data; charset=utf-8; boundary="a b"')).toBe("a b");
    expect(multipartBoundary("application/json")).toBeNull();
    expect(multipartBoundary("multipart/form-data")).toBeNull();
  });

  it("reads the wanted text fields, every occurrence, and skips the rest", () => {
    const bytes = form(
      part('Content-Disposition: form-data; name="file"; filename="a.mp3"\r\nContent-Type: audio/mpeg', "\r\n--XyY near miss\r\nbinary"),
      part('Content-Disposition: form-data; name="model"', "whisper-1"),
      part('Content-Disposition: form-data; name="response_format"', "json"),
      part('content-disposition: form-data; name="model"', "other"),
      part('Content-Disposition: form-data; name="prompt"', "x".repeat(5000)),
    );
    const fields = scan(bytes);
    expect(fields.get("model")).toEqual(["whisper-1", "other"]);
    expect(fields.get("response_format")).toEqual(["json"]);
    expect(fields.has("prompt")).toBe(false);
  });

  it("gives no value for a wanted field that is a file or too long to be a name", () => {
    const bytes = form(
      part('Content-Disposition: form-data; name="model"; filename="m.txt"', "whisper-1"),
      part('Content-Disposition: form-data; name="response_format"', "j".repeat(2000)),
    );
    expect(scan(bytes)).toEqual(new Map([["model", [null]], ["response_format", [null]]]));
  });

  it("reads a form after a preamble, and one with no wanted field", () => {
    const bytes = encode(`preamble\r\n${part('Content-Disposition: form-data; name="model"', "m")}--${B}--`);
    expect(scan(bytes).get("model")).toEqual(["m"]);
    expect(scan(form(part('Content-Disposition: form-data; name="file"; filename="a"', "x"))).size).toBe(0);
  });

  it("refuses what the platform's parser refuses: an unquoted name, a name in another case, a type in another case", async () => {
    const refused = [
      'form-data; name=model',
      'form-data; NAME="model"',
      'Form-Data; name="model"',
      "form-data; name*=UTF-8''model",
      'form-data; filename=""; name="model"',
      'form-data; size=1; name="model"',
      'form-data; name=""',
    ];
    for (const disposition of refused) {
      const bytes = form(part(`Content-Disposition: ${disposition}`, "m")) as Uint8Array<ArrayBuffer>;
      const platform = new Request("https://local.invalid", { method: "POST", headers: { "content-type": `multipart/form-data; boundary=${B}` }, body: bytes }).formData();
      await expect(platform, disposition).rejects.toThrow();
      expect(() => scan(bytes), disposition).toThrow(MultipartError);
    }
  });

  it("refuses a form it cannot read exactly", () => {
    const refused = [
      encode(part('Content-Disposition: form-data; name="model"', "m")), // never closed
      encode("no boundary at all"),
      form(part("Content-Type: text/plain", "m")), // no Content-Disposition
      form(part("Content-Disposition: form-data; name*=UTF-8''model", "m")), // an encoded name
      form(part("Content-Disposition: attachment; name=model", "m")),
    ];
    for (const bytes of refused) expect(() => scan(bytes), new TextDecoder().decode(bytes)).toThrow(MultipartError);
  });

  // Run in the Workers pool, so the platform's parser here is workerd's, as the gateway's.
  it("reads the same fields as the platform's own parser, across odd but valid forms", async () => {
    const wanted = ["model", "response_format", "service_tier"];
    const forms: [label: string, parts: string[]][] = [
      ["a semicolon in a quoted filename", [part('Content-Disposition: form-data; name="file"; filename="interview; take 2.mp3"', "x"), part('Content-Disposition: form-data; name="model"', "whisper-1")]],
      ["an escaped quote in a filename", [part('Content-Disposition: form-data; name="file"; filename="say \\"hi\\".mp3"', "x"), part('Content-Disposition: form-data; name="model"', "m")]],
      ["odd spacing", [part('Content-Disposition:form-data;name="model" ;  filename = "a b.txt"', "m"), part('Content-Disposition: form-data ;name = "response_format";', "json")]],
      ["a tab", [part('Content-Disposition: form-data;\tname="model"', "gpt"), part('Content-Disposition: form-data; name="service_tier"', "flex")]],
      ["a quoted semicolon in a name", [part('Content-Disposition: form-data; name="a;b"', "x"), part('Content-Disposition: form-data; name="model"', "m")]],
      ["filename* beside a plain filename", [part(`Content-Disposition: form-data; name="model"; filename="a.txt"; filename*=UTF-8''b.txt`, "m"), part('Content-Disposition: form-data; name="response_format"', "json")]],
      ["filename* alone, read as text", [part("Content-Disposition: form-data; name=\"model\"; filename*=UTF-8''a.txt", "whisper-1")]],
      ["an empty filename, read as text", [part('Content-Disposition: form-data; name="model"; filename=""', "whisper-1")]],
      ["filename* before filename: the parameters stop at filename*, so it is text", [part(`Content-Disposition: form-data; name="model"; filename*=UTF-8''b.txt; filename="a.txt"`, "whisper-1")]],
      ["an empty filename before another: the parameters stop there", [part('Content-Disposition: form-data; name="model"; filename=""; filename="a.txt"', "whisper-1")]],
      ["a name given twice: the last counts", [part('Content-Disposition: form-data; name="other"; name="model"', "whisper-1")]],
      ["a name after an unquoted parameter is not read", [part('Content-Disposition: form-data; name="model"; size=12; name="prompt"', "whisper-1")]],
      ["line feeds without carriage returns", []],
      ["repeated fields", [part('Content-Disposition: form-data; name="model"', "a"), part('Content-Disposition: form-data; name="model"', "b")]],
      ["a form built by the platform", []],
    ];
    for (const [label, parts] of forms) {
      let bytes: Uint8Array<ArrayBuffer>;
      let boundary = B;
      if (label === "line feeds without carriage returns") {
        bytes = encode(`--${B}\nContent-Disposition: form-data; name="model"\n\nwhisper-1\n--${B}\nContent-Disposition: form-data; name="response_format"\n\njson\r\n--${B}--\n`) as Uint8Array<ArrayBuffer>;
      } else if (parts.length === 0) {
        const source = new FormData();
        source.append("model", "gpt-4o-transcribe");
        source.append("file", new Blob([new Uint8Array(4096).fill(13)]), "a; b \"c\".mp3");
        source.append("response_format", "verbose_json");
        const request = new Request("https://local.invalid", { method: "POST", body: source });
        boundary = multipartBoundary(request.headers.get("content-type")!)!;
        bytes = new Uint8Array(await request.arrayBuffer());
      } else {
        bytes = form(...parts) as Uint8Array<ArrayBuffer>;
      }
      let platform: FormData;
      try {
        platform = await new Request("https://local.invalid", {
          method: "POST",
          headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
          body: bytes,
        }).formData();
      } catch (error) {
        throw new Error(`the platform refuses the form with ${label}: ${String(error)}`);
      }
      const expected = new Map<string, (string | null)[]>();
      for (const name of wanted) {
        const values = platform.getAll(name).map((value) => (typeof value === "string" ? value : null));
        if (values.length > 0) expected.set(name, values);
      }
      expect(scanMultipart(bytes, boundary, new Set(wanted)), label).toEqual(expected);
    }
  });
});
