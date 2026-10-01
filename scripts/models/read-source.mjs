// Shared by the daily sync and explicit model decisions. No fetched code is run.
import { ParseError } from "./price.mjs";
import { sourceId } from "./sources.mjs";

export async function fetchText(url, type) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "user-agent": "app-ai-gateway-price-sync (+https://github.com/maxceem/app-ai-gateway)" },
        signal: AbortSignal.timeout(20_000),
        redirect: "follow",
      });
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.startsWith(type)) throw new Error(`content type "${contentType}", expected ${type}`);
      return await response.text();
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`fetch failed: ${lastError?.message ?? lastError}`);
}

export async function readSource(source, models, today) {
  if (!source) return undefined;
  const wanted = new Set(Object.keys(models).map((model) => sourceId(source, model)));
  let text;
  try {
    text = await fetchText(source.url, source.type);
  } catch (error) {
    return { error: error.message };
  }
  try {
    return { result: source.parse(text, { wanted, today }) };
  } catch (error) {
    if (error instanceof ParseError) return { error: error.message };
    throw error;
  }
}
