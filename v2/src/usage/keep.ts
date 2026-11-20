/**
 * Keeping text past the piece it came from.
 *
 * A string cut from a larger one may share that one's memory, so a short
 * value kept from a 20 MB piece of a response could keep the whole piece
 * alive. The rule, for the framer (`./frames.ts`) and the skimmer
 * (`./skim.ts`): anything they hold after a `push()` returns goes through
 * `keep`, and nothing else may hold a slice across pushes.
 */

/** `text` in storage of its own: `JSON.parse` always builds a new string. */
export function keep(text: string): string {
  return text.length === 0 ? "" : (JSON.parse(JSON.stringify(text)) as string);
}
