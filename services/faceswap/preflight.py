"""Preflight: verify the local swap service can actually run, WITHOUT paying.

Checks, in order:
  1. the whole python stack imports (insightface, onnxruntime, cv2)
  2. buffalo_l detection loads and finds a face in a real image
  3. inswapper_128.onnx is present and loads as a genuine swapper model

Step 3 is the only one gated on a file you supply (see PLACE_INSWAPPER_HERE.txt).
Steps 1-2 pass without it, so you can confirm the machine is ready before
sourcing the weights.

    .venv/Scripts/python.exe preflight.py [optional_face_image.jpg]

Exit 0 = fully ready. Exit 3 = ready except the weights are missing.
"""

from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_ROOT = os.path.join(HERE, "models")
SWAPPER_PATH = os.path.join(MODEL_ROOT, "inswapper_128.onnx")

# A committed page with a clear face makes a fine default detection target.
DEFAULT_IMAGE = os.path.normpath(os.path.join(HERE, "..", "..", "apps", "api", "demo", "keep-demo", "astronaut.png"))


def ok(msg: str) -> None:
    print(f"  [ok]   {msg}")


def fail(msg: str) -> None:
    print(f"  [FAIL] {msg}")


print("\n1. imports")
try:
    import cv2
    import insightface  # noqa: F401
    import onnxruntime
    from insightface.app import FaceAnalysis

    ok(f"insightface {insightface.__version__}, onnxruntime {onnxruntime.__version__}, cv2 {cv2.__version__}")
except Exception as exc:  # noqa: BLE001
    fail(f"stack does not import: {exc}")
    print("\n  -> run: .venv/Scripts/python.exe -m pip install -r requirements.txt\n")
    sys.exit(1)

print("\n2. detection (buffalo_l)")
image_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_IMAGE
try:
    app = FaceAnalysis(name="buffalo_l", root=MODEL_ROOT, providers=["CPUExecutionProvider"])
    app.prepare(ctx_id=-1, det_size=(640, 640))
    img = cv2.imread(image_path)
    if img is None:
        fail(f"could not read image {image_path}")
        sys.exit(1)
    faces = app.get(img)
    if not faces:
        fail(f"no face detected in {image_path} — try a clear front-facing photo")
        sys.exit(1)
    ok(f"detected {len(faces)} face(s) in {os.path.basename(image_path)} ({img.shape[1]}x{img.shape[0]})")
except Exception as exc:  # noqa: BLE001
    fail(f"detection failed: {exc}")
    sys.exit(1)

print("\n3. swap weights (inswapper_128.onnx)")
if not os.path.isfile(SWAPPER_PATH):
    fail(f"not found at {SWAPPER_PATH}")
    print("       see services/faceswap/models/PLACE_INSWAPPER_HERE.txt\n")
    print("  Everything else is ready. Supply the weights file to finish.\n")
    sys.exit(3)

try:
    swapper = insightface.model_zoo.get_model(SWAPPER_PATH, providers=["CPUExecutionProvider"])
    if swapper is None:
        fail("file loaded but did not resolve to a swapper model — wrong or corrupt file")
        sys.exit(1)
    ok(f"loaded {os.path.basename(SWAPPER_PATH)} as {type(swapper).__name__}")
except Exception as exc:  # noqa: BLE001
    fail(f"could not load weights: {exc}")
    sys.exit(1)

print("\nAll checks passed — the local swap service is fully ready.\n")
sys.exit(0)
