# Homestead brand asset index (PHA-2846)

This document is the **single source of truth** for which brand file is canonical and where it is consumed in the app. If you change any of these paths, update both the path here AND the consumer in the same PR — out-of-sync assets have shipped twice (PHA-2846 caught it).

## Locked palette

Sourced from `agents/ledger/assets/homestead/canonical/README.md` (Brandon, 2026-08-28):

| Token | Hex | Use |
|-------|-----|-----|
| `--brand-olive` | `#4b4624` | door frame, doorway tile, dark wood |
| `--brand-sage` | `#6d7b59` | door panel, header lockup (legacy) |
| `--brand-paper` | `#f6e4c3` | parchment ground, cream interior |
| `--brand-hearth` | `#ad5c05` | hearth glow, flame core |
| `--brand-hearth-canonical` | `#ad5c05` | (alias) |
| `--brand-brass` | `#d49a40` | door knob, hinge pins, small accents |
| `--ink` | `#2B2622` | primary text |

## Canonical opening-door mark

**Source file:** `public/icon.svg` (the SVG is canonical; PNG variants are rasterizations of it).

The canonical opening-door mark is derived from the OUT NOW teaser (Brandon, 2026-08-28) and the canonical logo asset in `agents/ledger/assets/homestead/canonical/homestead-logo-canonical.png`. Composition:

- Sage/olive door panel (`#6d7b59`) hinged at the doorway's right jamb.
- Door is open outward toward viewer-right; slab sits to the right of the arched doorway, overlapping the right portion of the exterior wall.
- Brass handle on the slab's free right edge near mid-height.
- Warm amber hearth glow visible inside the arched doorway opening on the left half.
- Dark olive rounded square background (`rx=112`, fill `#4b4624`).

### Consumer map (must stay in sync)

| File | Use | Notes |
|------|-----|-------|
| `public/icon.svg` | SVG icon, used wherever an inline vector mark is wanted (favicon, header `<img class="brand-icon">`) | **Source of truth.** |
| `public/favicon.svg` | Browser tab icon (`<link rel="icon" href="/favicon.svg" type="image/svg+xml">`) | Identical content to `public/icon.svg`. |
| `public/icon-192.png` | PWA install icon (192×192), `purpose: any` | Rasterized from `icon.svg`. |
| `public/icon-512.png` | PWA install icon (512×512), `purpose: any` | Rasterized from `icon.svg`. |
| `public/icon-maskable.svg` | PWA maskable SVG, scaled to safe-zone | Scaled 0.7×, centered. |
| `public/icon-maskable-512.png` | PWA maskable raster, 512×512, `purpose: maskable` | Rasterized from `icon-maskable.svg`. |
| `public/manifest.json` | PWA manifest referencing the above | Update if you add/remove icons. |
| `public/sw.js` | Service worker `PRECACHE_URLS` (cache key `homestead-v5`) | Bump version (`homestead-v6`, etc) on any change to the icon set. |

### To regenerate after editing the SVG

```bash
rsvg-convert -w 192 -h 192 -b "#4b4624" public/icon.svg          -o public/icon-192.png
rsvg-convert -w 512 -h 512 -b "#4b4624" public/icon.svg          -o public/icon-512.png
rsvg-convert -w 512 -h 512            public/icon-maskable.svg   -o public/icon-maskable-512.png
```

## Built-in module icons (Add Rooms picker + Apps sheet)

**Source directory:** `public/modules/` — six SVGs, one per built-in module key. The 16-field registry contract (PHA-2201) keeps `icon` as a non-empty string; for built-ins it's now a path like `/modules/porch.svg`. The renderer dispatches on prefix:

- `/modules/` prefix → `<img>` (built-in SVG)
- anything else → escaped emoji glyph (third-party manifest)

| Module key | SVG | Visual vocabulary |
|------------|-----|-------------------|
| `wall` (Porch) | `public/modules/porch.svg` | Door — same olive/sage arch shape as the canonical opening-door, simplified for tile use |
| `lists` | `public/modules/lists.svg` | Folio — paper sheet with checkbox marks + brass pencil |
| `calendar` | `public/modules/calendar.svg` | Household calendar — card with brass rings + dome |
| `chores` | `public/modules/chores.svg` | Broom + check disc |
| `apps` | `public/modules/apps.svg` | Cabinet — house-shaped organizer with brass knob |
| `agent` (Hearth) | `public/modules/agent.svg` | Hearth lantern — the agent character |

All six SVGs share the canonical palette (`#4b4624` olive, `#6d7b59` sage, `#f6e4c3` cream, `#ad5c05` amber, `#d49a40` brass) so they read as one household vocabulary.

### Consumer map

| File | Use |
|------|-----|
| `public/modules/{key}.svg` | Source SVG, served at `/modules/{key}.svg` |
| `public/modules.html` | Add Rooms picker — renders `<img>` for built-ins |
| `public/index.html` (Settings → Apps rows + App detail header) | Renders `<img>` for built-in rows; emoji for third-party |
| `public/sw.js` | Precache list — bump cache version on any change |

## Hearth character art

**Source directory:** `docs/brand/hearth/`

| File | Use |
|------|-----|
| `docs/brand/hearth/avatar.png` | Hearth's static avatar — a vintage oil/kerosene lantern, warm brass + olive cap, ember-orb face with two vertical oval eye-slits |
| `docs/brand/hearth/animation-frames.png` | Six-frame animation source sheet — 2×3 grid, read **left-to-right, then top-to-bottom**. Only flame tips, side wisps, sparks, and glow animate; ember-orb body and eyes stay fixed. |

**Do not silently make a GIF from the sheet** unless the runtime needs one. Preserve the source sheet as-is.

## Teaser art

**Source directory:** `docs/brand/teasers/` — finished vertical teasers, durable project brand assets.

| File | Use |
|------|-----|
| `docs/brand/teasers/teaser-out-now.png` | Exterior announcement teaser (CLOSED BETA — OUT NOW!) |
| `docs/brand/teasers/teaser-add-rooms.png` | Add Rooms product teaser (CLOSED BETA — INVITE ONLY) |

These are **durable** brand assets, not transient chat outputs. Do not overwrite them without retaining the prior version.

## Banner

| File | Use |
|------|-----|
| `docs/brand/homestead-banner.png` | README banner — wider variant of the canonical lockup (2172×724) |

## What is NOT canonical

- `public/brand-hero.png` — full canonical login lockup (icon + wordmark on transparent ground). Source: `agents/ledger/assets/homestead/canonical/login-lockup-canonical.png`.
- `public/wordmark.svg` — carved-wood vector wordmark. Source: `agents/ledger/assets/homestead/canonical/wordmark-canonical.svg`. The wordmark answers the typeface question (vectorize THIS lettering); don't substitute Fraunces.

## Related

- [PHA-2846](https://paperclip.phatt.vip/issues/PHA-2846) — this index's parent issue
- [PHA-2777](https://paperclip.phatt.vip/issues/PHA-2777) — brand-system canonical assets (predecessor)
- `agents/ledger/assets/homestead/canonical/README.md` — locked brand README (Brandon, 2026-08-28)
