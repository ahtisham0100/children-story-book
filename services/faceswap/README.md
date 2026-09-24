# services/faceswap — the swap stage, self-hosted

Runs the *same* inswapper model the pipeline already uses, with the models
loaded once at boot instead of once per request.

## Why

The hosted swap bills ~$0.006 per call at Replicate's CPU rate of $0.0001/s.
That is **~60 seconds of billed CPU** for a model whose real inference is well
under a second. The minute is cold start — every call reloads the buffalo_l
analysis pack plus `inswapper_128.onnx` (several hundred MB) off disk, runs one
image, and discards it.

| | hosted | here (CPU) |
|---|---|---|
| swap stage | 55–90s | ~3.5s (measured) |
| **page total** | **90–170s** | **~15–25s** |

The knock-on matters more than the stage does. A 24-page book today is
`24 × ~120s ÷ 3 concurrent ≈ 16 minutes`, which is not a product. At ~15s/page
with room to raise concurrency it is well under a minute.

Two things come free with it. Retries stop costing 60s each, so the "No face
found" flakiness that the pipeline currently absorbs with four *paid* retries
becomes near-free to handle — and detection tuning (`FACESWAP_DET_SIZE`) becomes
a local sweep rather than a paid round trip per attempt.

### Measured (2026-07-20)

Not a projection — `npm run bench:swap`, 5 runs, on a 6-core CPU box with **no
GPU**, through the real Node→service path the pipeline uses:

```
median 3.45s   mean 3.80s   range 3.01–4.69s   5/5 succeeded
vs hosted ~70s (measured 55–90s)  →  ~20x
```

~3.5s, not the sub-second inference alone, because each swap also runs two face
detections (source + target) and a full HTTP+base64 round trip. Still ~20x, and
the swap was the pipeline's dominant term, so the page total lands at ~15–25s.
On a CUDA box this drops further (inference ~50–100ms); the detections and round
trip would then dominate.

## You must supply the weights

`inswapper_128.onnx` is **not** in this repo and is not downloaded automatically.
InsightFace withdrew it from official distribution; the copies that circulate are
third-party re-uploads of unverified provenance, so this project does not fetch
one for you and you should not point it at a random mirror.

Obtain it through a route you trust — which in practice is the same conversation
as the commercial licence, since **inswapper is licensed for non-commercial and
research use only** and this is a paid product. Self-hosting does not soften that;
if anything it makes the use more clearly your own. See "Known state" in
`apps/api/README.md`.

Then place it at:

```
services/faceswap/models/inswapper_128.onnx
```

and run `preflight.py` (below) to confirm it loads before wiring anything up.

`buffalo_l` (detection + landmarks) *is* fetched automatically on first run from
InsightFace's own release URLs, into `services/faceswap/models/`.

## Run it

```bash
cd services/faceswap
python -m venv .venv
.venv/Scripts/activate          # Windows;  source .venv/bin/activate elsewhere
pip install -r requirements.txt
python app.py                   # http://127.0.0.1:5175
```

First start downloads buffalo_l and takes a minute or two. After that startup is
seconds, and `GET /health` reports `{"ready": true}`.

### Check it's ready before spending anything

```bash
.venv/Scripts/python.exe preflight.py
```

Verifies the stack imports, buffalo_l detects a real face, and — if you've
placed them — the swap weights load as a genuine model. Exit 0 means fully
ready; exit 3 means everything works except the weights are still missing.
Costs nothing and hits no paid API.

Then point the pipeline at it — in `apps/api/.env`:

```
SWAP_BACKEND=local
```

That is the whole switch. `SWAP_BACKEND` defaults to `replicate`, so anyone
without this service running is unaffected.

## Config

| Env var | Default | Notes |
|---|---|---|
| `FACESWAP_PORT` | `5175` | |
| `FACESWAP_HOST` | `127.0.0.1` | Loopback by default — do not expose this publicly without auth in front. |
| `FACESWAP_DET_SIZE` | `640` | Detection resolution. Higher finds smaller faces at more cost. Free to sweep now. |
| `FACESWAP_MODEL_ROOT` | `./models` | Where weights live. |
| `FACESWAP_WORKERS` | `1` | Real concurrency, at a RAM cost — see "Concurrency note" below before raising this. |

## API

`POST /swap` — `{ "input_image": "<b64>", "swap_image": "<b64>" }`, either
optionally data-URI wrapped. Returns `{ "image": "<b64 png>", "timing_ms": {...} }`.

A detection miss returns **HTTP 422** with `{"error": "no_face"}`. This is
deliberate and load-bearing: the Node caller retries that specific failure and
maps it to a specific user-facing message. A generic 500 would silently break
that path.

`GET /health` — `{ "ready": bool, "error": str|null, ... }`.

## GPU

This machine has no CUDA device, so the service pins `CPUExecutionProvider` and
the numbers above are CPU numbers. On a CUDA box: install `onnxruntime-gpu`
instead of `onnxruntime` and put `"CUDAExecutionProvider"` first in the
`providers` list in `app.py`. Inference drops to roughly 50–100ms. Nothing else
changes.

Concurrency note: inference is serialised behind one in-process lock, so
throughput here comes from models being warm rather than from parallelism —
concurrent pages/characters (`CONCURRENCY = 3` in personalize.ts) queue
behind it instead of running in parallel. `FACESWAP_WORKERS` fixes that for
real (separate OS processes, each with its own lock and its own resident
models), but each worker costs RAM — measured ~1GB resident per worker on
this box. **`RESTORE_WORKERS=2` was tried on this box and reverted — it made
real usage slower, because committed memory (RAM + page file), not free
RAM, was the actual constraint; see services/restore/README.md's
"Concurrency" section for the full story before touching this one too.** On
a box with real headroom (checked via commit charge, not `FreeGB`),
services/restore is still the better place to spend it — that
headroom first, since restore's inference (~7-13s) dominates swap's
(~3.5s total) by a wide margin.
