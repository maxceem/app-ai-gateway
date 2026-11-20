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
      part("Content-Disposition: form-data; name=response_format", "json"),
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

  it("refuses a form it cannot read exactly", () => {
    const refused = [
      encode(part('Content-Disposition: form-data; name="model"', "m")), // never closed
      encode("no boundary at all"),
      form(part("Content-Type: text/plain", "m")), // no Content-Disposition
      form(part("Content-Disposition: form-data; name*=UTF-8''model", "m")), // an encoded name
      form(part('Content-Disposition: form-data; name="a"; name="model"', "m")), // two names
      form(part("Content-Disposition: attachment; name=model", "m")),
    ];
    for (const bytes of refused) expect(() => scan(bytes), new TextDecoder().decode(bytes)).toThrow(MultipartError);
  });

  it("reads the same fields the platform's own parser does", async () => {
    const source = new FormData();
    source.append("model", "gpt-4o-transcribe");
    source.append("file", new Blob([new Uint8Array(4096).fill(13)]), "audio.mp3");
    source.append("response_format", "verbose_json");
    const request = new Request("https://local.invalid", { method: "POST", body: source });
    const boundary = multipartBoundary(request.headers.get("content-type")!)!;
    const fields = scanMultipart(new Uint8Array(await request.arrayBuffer()), boundary, new Set(["model", "response_format"]));
    expect(fields).toEqual(new Map([["model", ["gpt-4o-transcribe"]], ["response_format", ["verbose_json"]]]));
  });
});
