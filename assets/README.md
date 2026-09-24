# assets

Client-provided and QA assets.

- `templates/` — the page artwork. Pages are registered in
  `apps/api/src/pipeline/catalog.ts`; adding one is a single entry there, with no code and no
  per-template calibration.

  Two kinds live here today:
  - **`newtemp.jpg`, `newtemp2.jpg`** — clean two-character illustration, already at the right
    framing. These are what the engine is meant to consume.
  - **`temp_1.jpeg`, `temp_2.jpeg`, and the WhatsApp-named file** — screenshots of a
    competitor's preview flow, with French UI chrome baked into the pixels (not overlaid).
    The `crop` field in `catalog.ts` strips that chrome. They demonstrate the engine fine but
    are **not shippable page art** and need replacing with real illustration.

  New art must be **soft-shaded/painterly**, not flat vector and not chibi — the swap model's
  own face detector reliably fails on both. See `apps/api/README.md` "Known state".

- `style-refs/` — illustration style reference images from the client.

- `test-photos/` — consented/stock photos for QA only. **Git-ignored** for privacy; a fresh
  clone has none, and whoever runs the demo supplies their own. Do not commit real photos of
  children.
