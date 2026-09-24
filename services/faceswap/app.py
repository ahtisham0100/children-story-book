"""Local face-swap service — the same inswapper model, without the 60-second tax.

WHY THIS EXISTS
---------------
The hosted swap (Replicate `codeplugtech/face-swap`) bills ~$0.006 per call at
CPU rates of $0.0001/s. Divide it out: that is ~60 SECONDS of billed CPU for a
model whose actual inference is well under a second. The time is not queue wait
and it is not the swap — it is cold start. Every hosted call reloads the
buffalo_l analysis pack plus inswapper_128.onnx (several hundred MB) from disk,
runs one image through, and throws the loaded models away.

This service loads those models ONCE at startup and keeps them resident. The
per-request cost collapses to actual inference.

    hosted:  55-90s per swap
    here:    ~3.5s per swap on CPU (measured, median of 5 runs on a 6-core box)

That takes a page from ~90-170s to ~15-25s and makes full-book rendering viable
at all — see the arithmetic in README.md.

CONTRACT
--------
Deliberately mirrors the hosted model's semantics so `stages/swap.ts` can treat
the two backends as interchangeable. In particular a face-detection miss returns
HTTP 422 with `{"error": "no_face", ...}` rather than a 500, because the Node
side retries that specific failure and surfaces a specific user-facing message
for it. Collapsing it into a generic error would silently break that path.

LICENSING
---------
This runs InsightFace's inswapper, which is licensed for non-commercial and
research use only. Self-hosting does not change that — arguably it makes the
use more clearly the licensee's own. A commercial licence is required before
this ships as a paid product. See "Known state" in apps/api/README.md.
"""

from __future__ import annotations

import base64
import binascii
import logging
import os
import threading
import time
from typing import Any

import cv2
import numpy as np
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="[faceswap] %(message)s")
log = logging.getLogger("faceswap")

# Where the weights live. buffalo_l is fetched automatically by insightface from
# its own release URLs; inswapper_128.onnx is NOT — see README.md, it has to be
# placed here deliberately.
MODEL_ROOT = os.environ.get("FACESWAP_MODEL_ROOT", os.path.join(os.path.dirname(__file__), "models"))
SWAPPER_PATH = os.path.join(MODEL_ROOT, "inswapper_128.onnx")

# Detection resolution. Bigger finds smaller faces at more cost. 640 matches the
# insightface default and is what the hosted model effectively used; the whole
# point of running locally is that sweeping this is now free, so it is tunable
# without a paid round trip per attempt.
DET_SIZE = int(os.environ.get("FACESWAP_DET_SIZE", "640"))

# onnxruntime releases the GIL during inference, but insightface's model objects
# are not documented as thread-safe and the app server may serve concurrent
# requests. One lock around inference keeps this honest; throughput comes from
# the models being warm, not from in-process parallelism.
_lock = threading.Lock()

_analyser: Any = None
_swapper: Any = None
_ready = False
_load_error: str | None = None


def _load_models() -> None:
    """Load once, at startup. This is the whole point of the service."""
    global _analyser, _swapper, _ready, _load_error

    try:
        import insightface
        from insightface.app import FaceAnalysis
    except ImportError as exc:  # pragma: no cover - environment problem, not logic
        _load_error = f"insightface is not installed: {exc}. See services/faceswap/README.md."
        log.error(_load_error)
        return

    if not os.path.isfile(SWAPPER_PATH):
        _load_error = (
            f"inswapper weights not found at {SWAPPER_PATH}. This file is not "
            "redistributed with the repo and must be supplied deliberately — see "
            "services/faceswap/README.md."
        )
        log.error(_load_error)
        return

    started = time.perf_counter()

    # CPUExecutionProvider only: this machine has no CUDA device. On a CUDA box,
    # putting "CUDAExecutionProvider" first is the only change needed and takes
    # inference to roughly 50-100ms.
    providers = ["CPUExecutionProvider"]

    log.info("loading buffalo_l (detection + landmarks)...")
    analyser = FaceAnalysis(name="buffalo_l", root=MODEL_ROOT, providers=providers)
    analyser.prepare(ctx_id=-1, det_size=(DET_SIZE, DET_SIZE))

    log.info("loading inswapper_128...")
    swapper = insightface.model_zoo.get_model(SWAPPER_PATH, providers=providers)

    _analyser = analyser
    _swapper = swapper
    _ready = True
    log.info("models resident after %.1fs — every request from here is warm", time.perf_counter() - started)


app = FastAPI(title="Local face swap", version="1.0.0")


@app.on_event("startup")
def _startup() -> None:
    # Load synchronously: a request arriving mid-load would otherwise race, and
    # the whole contract of this service is that models are already resident.
    _load_models()


class SwapRequest(BaseModel):
    # Base64 PNG/JPEG bytes, with or without a data: prefix.
    input_image: str  # the artwork being personalized (the target)
    swap_image: str  # the child's photo (the identity source)


def _decode(field: str, value: str) -> np.ndarray:
    """Base64 (optionally data-URI wrapped) -> BGR image array."""
    if value.startswith("data:"):
        _, _, value = value.partition(",")
    try:
        raw = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError(f"{field} is not valid base64: {exc}") from exc

    image = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"{field} did not decode to an image.")
    return image


def _largest_face(image: np.ndarray) -> Any:
    """The biggest detected face, or None.

    Biggest rather than highest-confidence deliberately: the pipeline has
    already cropped to one character before this runs, so the subject is the
    dominant face, and confidence ranking has historically promoted background
    artefacts (a rocket window scored 0.874 on one page).
    """
    faces = _analyser.get(image)
    if not faces:
        return None
    return max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ready": _ready,
        "error": _load_error,
        "det_size": DET_SIZE,
        "providers": ["CPUExecutionProvider"],
    }


@app.post("/swap")
def swap(req: SwapRequest) -> Any:
    if not _ready:
        return JSONResponse(
            status_code=503,
            content={"error": "not_ready", "message": _load_error or "Models are still loading."},
        )

    started = time.perf_counter()

    try:
        target = _decode("input_image", req.input_image)
        source = _decode("swap_image", req.swap_image)
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": "bad_input", "message": str(exc)})

    with _lock:
        detect_started = time.perf_counter()
        source_face = _largest_face(source)
        if source_face is None:
            # Same shape as a target miss: the Node side retries both and shows
            # one message, because a parent cannot act on the distinction.
            return JSONResponse(
                status_code=422,
                content={"error": "no_face", "message": "No face found in the photo."},
            )

        target_face = _largest_face(target)
        if target_face is None:
            return JSONResponse(
                status_code=422,
                content={"error": "no_face", "message": "No face found in the artwork."},
            )
        detect_ms = (time.perf_counter() - detect_started) * 1000

        swap_started = time.perf_counter()
        result = _swapper.get(target, target_face, source_face, paste_back=True)
        swap_ms = (time.perf_counter() - swap_started) * 1000

    ok, encoded = cv2.imencode(".png", result)
    if not ok:
        return JSONResponse(
            status_code=500,
            content={"error": "encode_failed", "message": "Could not encode the swapped image."},
        )

    total_ms = (time.perf_counter() - started) * 1000
    log.info("swap ok — detect %.0fms, swap %.0fms, total %.0fms", detect_ms, swap_ms, total_ms)

    return {
        "image": base64.b64encode(encoded.tobytes()).decode("ascii"),
        "timing_ms": {"detect": round(detect_ms), "swap": round(swap_ms), "total": round(total_ms)},
    }


if __name__ == "__main__":
    import uvicorn

    # See services/restore/app.py's identical block for the full reasoning:
    # each worker is a separate process with its own lock and its own
    # resident models, which is what buys real concurrency instead of
    # requests queueing behind one in-process lock. Costs RAM per worker —
    # default 1 preserves today's behaviour.
    workers = int(os.environ.get("FACESWAP_WORKERS", "1"))
    uvicorn.run(
        "app:app" if workers > 1 else app,
        host=os.environ.get("FACESWAP_HOST", "127.0.0.1"),
        port=int(os.environ.get("FACESWAP_PORT", "5175")),
        log_level="info",
        workers=workers,
    )
