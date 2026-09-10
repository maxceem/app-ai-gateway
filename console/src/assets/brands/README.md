# Brand marks

One SVG per provider type, per gateway type, and per authentication vendor,
named after the key it is looked up by — the `ProviderType` and
`ProviderGatewayType` values in `src/shared/capabilities.ts`, and the `AuthBrand`
values in `brand-icon.tsx`. `brand-icon.tsx` maps those keys exhaustively, so a
provider type added to the matrix will not typecheck until its mark lands here.

The authentication marks are `firebase`, `supabase`, `auth0`, `clerk`, `apple`
and `revenuecat`: the identity providers `lib/presets.ts` has an issuer preset
for, plus Sign in with Apple, which the docs describe as a hand-configured
issuer, and RevenueCat, which the entitlement preset names. The `custom`
presets name no vendor, so they have no mark here: `preset-picker.tsx` leads
them with braces drawn from the icon set instead.

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

Lobe Icons is an AI-model catalogue and carries none of these, so the outlines
come from [`simple-icons`](https://github.com/simple-icons/simple-icons) (the
icons are CC0-1.0), with the same edits: the `<title>` and `role` are dropped,
and the wrapper's `height="1em" width="1em"` attributes are added. The paths are
left with the default `nonzero` fill rule they were drawn for — Clerk's mark has
a solid centre dot that `evenodd` would punch a hole through.

These are coloured too, for the same reason the marks above are: a vendor is
recognised by its colour before its shape, and a row of grey outlines beside a
row of brand colour reads as two different kinds of thing.

Auth0, Clerk and RevenueCat are single-colour marks, so the simple-icons outline
is simply painted in the brand's own hex, which `simple-icons` publishes beside
each icon and sources from the vendor. Firebase and Supabase have genuine
multi-colour marks, so the official artwork is vendored instead of a flat
repaint — Firebase's three-tone flame, and Supabase's bolt with the green
gradient from `supabase/supabase`, whose gradient ids are renamed to the
`brand-<name>-<n>` form the marks above use.

Apple is the exception that keeps `fill="currentColor"`: the mark is black, has
no colour variant, and would disappear against the console's dark theme.

The marks are the trademarks of their respective owners, and identify the
service each row talks to.
