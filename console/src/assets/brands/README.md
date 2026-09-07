# Brand marks

One SVG per provider type, per gateway type, and per authentication vendor,
named after the key it is looked up by — the `ProviderType` and
`ProviderGatewayType` values in `src/shared/capabilities.ts`, and the `AuthBrand`
values in `brand-icon.tsx`. `brand-icon.tsx` maps those keys exhaustively, so a
provider type added to the matrix will not typecheck until its mark lands here.

The authentication marks are `firebase`, `supabase`, `auth0`, `clerk`, `apple`
and `revenuecat`: the identity providers `lib/presets.ts` has an issuer preset
for, plus Sign in with Apple, which the docs describe as a hand-configured
issuer, and RevenueCat, which the entitlement preset names. The `custom` presets
name no vendor and so have no mark.

## Model providers and gateways

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

## Authentication vendors

Lobe Icons is an AI-model catalogue and carries none of these, so they come from
[`simple-icons`](https://github.com/simple-icons/simple-icons) (the icons are
CC0-1.0), with the same edits: the `<title>` and `role` are dropped, and the
wrapper's `fill="currentColor" height="1em" width="1em"` attributes are added so
the mark inherits the surrounding text colour exactly as the ones above do.
Every one of them is a single-colour official mark, so there is no colour
variant to choose. The paths are left with the default `nonzero` fill rule they
were drawn for — Clerk's mark has a solid centre dot that `evenodd` would punch
a hole through.

The marks are the trademarks of their respective owners, and identify the
service each row talks to.
