# Brand marks

One SVG per provider type and per gateway type, named after the key it is
looked up by — the `ProviderType` and `ProviderGatewayType` values in
`src/shared/capabilities.ts`. `brand-icon.tsx` maps those keys exhaustively, so
a provider type added to the matrix will not typecheck until its mark lands
here.

Taken from [`@lobehub/icons-static-svg`](https://github.com/lobehub/lobe-icons)
(MIT), with three edits applied to each file:

- the generator's `flex:none;line-height:1` inline style is dropped, because
  the wrapper sizes and aligns the mark;
- its `<title>` is dropped, because the mark is always rendered beside the
  brand's name and a second copy would only add a hover tooltip;
- gradient ids lose the React `useId` suffix they were generated with, so the
  same mark rendered twice on a page references the same stable id.

The colour variant is used wherever the brand has one that reads on both a
light and a dark background. The rest are single-path marks that inherit the
surrounding text colour through `currentColor` — which is also what OpenRouter's
mark does here, because its brand colour is `#C8FF00` and all but disappears on
white.

The marks are the trademarks of their respective owners, and identify the
service each row talks to.
