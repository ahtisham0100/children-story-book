# Demo plan — 2026-07-17 (SUPERSEDED, kept as a record)

> **⚠️ Do not follow the procedure that used to be in this file.**
> **For running a demo, use [DEMO_RUNBOOK.md](DEMO_RUNBOOK.md).**
>
> This was the plan for the 2026-07-17 demo, when there were 3 templates and four
> separate CLI drivers. Its commands (`npx tsx demo/personalize.mts plane <photo>
> out.png`), its `TEMPLATES` constant, and its `--repaint-from` flag no longer exist —
> the drivers were merged into one `npm run personalize` on 2026-07-19 and the templates
> moved into `apps/api/src/pipeline/catalog.ts`. Its "~20s per image" figure was also
> wrong by an order of magnitude: a real page takes **~90–170s**.
>
> It is kept for the findings below, which are still true and were paid for.

## What was proven here

The **repaint-then-swap** recipe, which is still the engine today: `google/nano-banana`
repaints the whole illustration as the child (~$0.039, and it *sees the photo*, so one
generic prompt works for any child with no per-child hair/skin text and no seams), then a
face swap sharpens identity to exactly that child (~$0.006).

All three single-character templates were run with a real photo on 2026-07-17 and judged
demo-ready.

## Approaches rejected — do not re-litigate

- **Masked inpainting (FLUX Fill).** Preserves the original art pixel-perfectly, but that
  is the wrong optimization here. Left **visible seams and a bright halo** around the hair
  on open-background templates (the plane). **The client rejected it.**
- **flux-kontext (~$0.031).** Cheaper, but **blind to the photo** — it needs a written
  per-child hair/skin description — and it **broke art style on the astronaut** (flat
  cel-shaded face on a painterly body). Worth revisiting *only* as a production
  cost-optimization paired with caching; never as the demo path.
- **Face-swap alone.** Cannot touch hair, accessories or skin-on-body — measured, it
  changed only ~0.43% of a page. Necessary for identity, not sufficient alone.

## Per-template notes still worth knowing

| Page | Note |
|---|---|
| plane | The result the client loved. **Artifact: the original girl's pink headband survives the repaint** — nano-banana preserves template accessories. Flag it if the client wants it gone. |
| astronaut | Strong identity inside the helmet; the helmet also hides the repaint's tendency to lengthen short hair. The best single-character scene to lead with. |
| workshop | Clean, strong identity. Hands read slightly paler than the face. |

**Chrome crops** (competitor UI baked into the source pixels) are no longer set here —
they live in the `crop` field of each page in `catalog.ts`, which is authoritative. The
values were verified and carried over unchanged.

## Limits, still current

- Identity is a strong *resemblance* at small face sizes, not a perfect lock — the swap
  has less to work with the smaller the face.
- **Licensing:** the swap model (InsightFace inswapper) is non-commercial/research
  licensed. Fine for a demo; **must be resolved before selling.**
- The single-character templates are competitor screenshots. Real illustrator art is
  needed for a shippable product.
