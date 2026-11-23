/**
 * Whether text is well-formed: no half of a surrogate pair stands alone. Text
 * that is not cannot be put in a URL (`encodeURIComponent` throws on it), nor
 * reach a service that expects well-formed strings.
 */
export function wellFormedText(text: string): boolean {
  return !/\p{Cs}/u.test(text);
}
