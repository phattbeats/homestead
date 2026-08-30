## v0.5.5 (2026-08-30) — Brand system + BYOK modal fix + chore-module gate + wall notify wiring

Rolls up everything landed on `main` since v0.5.4 for the real-usage feedback
loop on PHA-2804: the brand system apply pass below, plus **PHA-2804: fix
BYOK token modal stuck after Stored** (the modal no longer hangs after a
successful token save), **PHA-2811: gate chore creation on the chores
module being enabled** (fixes the orphaned "help me make homestad" chore
Tyler couldn't close), and **PHA-2656: wire the wall notify-level dropdown**
to `GET/PUT /api/walls/:slug/notifications`.

## Homestead brand system lands (PHA-2777)

Brandon's canonical README (`vault/PHATT-TECH/Projects/homestead-app/canonical/homestead-logo-canonical.png`,
locked 2026-08-28) makes the carved-wood lettering in the lockup the wordmark itself —
the lockup answers the typeface question ("vectorize THIS lettering"). The
apply pass also picks up Brandon's 2026-08-30 09:31 EDT direction correction
("USE THE CANONICAL LOGO AND BANNER") and the 2026-08-30 10:01 EDT second-pass
correction ("STILL NOT THE RIGHT ASSETS") which replaced the spec-v3 Fraunces
hedges with the canonical SVG/PNG assets in `agents/ledger/assets/homestead/`.
Apply pass lands:

- **Canonical app icons**: olive/sage doorway with brass knob, hearth-lit
  interior. Painterly PNG for the standalone icon (the icon portion of
  the canonical lockup), flat SVG variants for header, favicon, and
  PWA manifest at 192/512. Maskable variant (full-bleed olive safe
  area) at 512.
- **Canonical wordmark** (`/public/wordmark.svg`): the carved-wood
  vector traced from `homestead/canonical/homestead-logo-canonical.png`
  — single-color `#4e2d0f` on transparent, 1206×514 viewBox. The lockup
  answers the typeface question; we render the SVG as `<img>` in the
  header lockup and never substitute a typeset alternative.
- **Canonical login hero** (`/public/brand-hero.png`): the **full** login
  lockup from `login-lockup-canonical.png` (icon + wordmark,
  transparent ground, 1774×887). NOT the standalone painterly icon
  — Brandon's 10:01 EDT correction explicitly showed `login-lockup-canonical.png`
  as the asset he wanted on the login screen.
- **Canonical README banner** (`docs/brand/homestead-banner.png`):
  `homestead-banner.png` from the canonical folder (2172×724 wide
  variant of the lockup). Replaces the prior `banner-canonical-readme.png`.
- **Local fonts**: self-hosted Fraunces Italic 400 (tagline) + Plus Jakarta
  Sans (400/800) under `/public/fonts/`, precached by `sw.js` for offline
  PWA. **Fraunces SemiBold 600 dropped** — the wordmark is now the SVG,
  not a typeset font. One shared font include in `brand.css` covers
  `index.html`, `porch.css`, `connectors.css`, and `consent.css`.
- **Header lockup**: doorway (canonical flat SVG) + canonical wordmark
  SVG side by side across `index.html`, the Porch standalone header
  (via `components/feed.js`), `connectors.html`, and `consent.html`.
- **Login surface**: full canonical lockup hero + Fraunces Italic 400
  tagline ("Your home. Your data. Your apps.") on the parchment-warm
  login card.
- **Muted token darken**: `--muted #8A8177` → `--muted #7a7269` (4.59:1
  contrast on `--bg #FFFBF5`, up from 3.71:1) so muted labels and button
  text pass WCAG AA.

Guardrails honored: body text stays Plus Jakarta Sans (readable sans);
the painterly mark only lives on login, splash, store, and README —
no teaser imagery in feeds, lists, settings, or Porch cards.


Brandon's brand spec (`vault/PHATT-TECH/Projects/homestead-app/brand/brand-spec-v3.md`)
locks the canonical doorway-with-handle as the product identity, with the
carved-wood wordmark in Fraunces SemiBold 600 + Fraunces Italic 400 for
the tagline. Apply pass lands:

- **Canonical app icons**: olive/sage doorway with brass knob, hearth-lit
  interior. Painterly PNG for the login hero (`/brand-hero.png`,
  1254×1254 master); flat SVG/PNG variants for header, favicon, and
  PWA manifest at 192/512. Maskable variant (full-bleed olive safe
  area) at 512.
- **Local fonts**: self-hosted Fraunces SemiBold 600 + Fraunces Italic 400
  + Plus Jakarta Sans (400/800) under `/public/fonts/`, precached by `sw.js`
  for offline PWA. One shared font include in `brand.css` covers
  `index.html`, `porch.css`, `connectors.css`, and `consent.css`.
- **Header lockup**: doorway + Fraunces "Homestead" wordmark across
  `index.html`, the Porch standalone header (via `components/feed.js`),
  `connectors.html`, and `consent.html`.
- **Login lockup**: painterly doorway hero + Fraunces wordmark + Fraunces
  Italic tagline ("Your home. Your data. Your apps.") on the parchment-warm
  login card.
- **README banner**: canonical `banner-canonical-readme.png` (2120×640)
  replaces the prior hand-drawn banner.
- **Muted token darken**: `--muted #8A8177` → `--muted #7a7269` (4.59:1
  contrast on `--bg #FFFBF5`, up from 3.71:1) so muted labels and button
  text pass WCAG AA.

Guardrails honored: body text stays Plus Jakarta Sans (readable sans);
the painterly mark only lives on login, splash, store, and README —
no teaser imagery in feeds, lists, settings, or Porch cards.
