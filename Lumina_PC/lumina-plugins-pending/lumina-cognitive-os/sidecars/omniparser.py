"""
omniparser.py — Visual Engine sidecar for Lumina (opt-in).

Wraps Microsoft OmniParser V2 (https://github.com/microsoft/OmniParser).
Takes a screenshot path, returns a list of detected UI elements with
bounding boxes + semantic labels + interactivity hints.

This sidecar is OPT-IN. Install deps with:
   pip install -r requirements-omniparser.txt
And download weights with:
   python omniparser.py --download

First parse() call lazily loads ~2GB of weights into VRAM/RAM. Subsequent
calls reuse the loaded model (warm), so the second invocation is fast.

Protocol (one JSON per stdout):
  python omniparser.py --image <path> [--device cuda|cpu] [--no-ocr]
       → {"ok": true, "elements": [...], "durationMs": N}
  python omniparser.py --health
       → {"ok": true, "ready": bool, "device": "...", "modelDir": "..."}
  python omniparser.py --download
       → {"ok": true, "downloaded": ["weights/icon_detect.pt", ...]}

If deps or weights are missing the sidecar exits 2 with a structured
hint, so the TS layer can surface install instructions instead of
crashing.

NOTE: this file intentionally does NOT pin to a specific OmniParser
version. It targets the canonical Microsoft repo's public Python API
(`microsoft/OmniParser` releases YOLOv8 + Florence-2 weights via HF
hub). If those break, see the upstream repo for the latest loader
recipe.
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import os
import sys
import time
import traceback
from pathlib import Path
from typing import Any, Dict, List, Optional


def fail(reason: str, code: int = 2, hint: Optional[str] = None) -> None:
    payload: Dict[str, Any] = {"ok": False, "error": reason}
    if hint:
        payload["hint"] = hint
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.exit(code)


def model_dir() -> Path:
    env = os.environ.get("LUMINA_OMNIPARSER_DIR", "").strip()
    if env:
        return Path(env).resolve()
    return Path("c:/I24D_WhatsApp/.models/omniparser").resolve()


def default_device() -> str:
    env = os.environ.get("LUMINA_OMNIPARSER_DEVICE", "").strip()
    if env:
        return env
    try:
        import torch  # type: ignore
        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Lumina OmniParser sidecar")
    p.add_argument("--image", type=str, default=None, help="Path to a PNG/JPEG to parse")
    p.add_argument("--device", type=str, default=None, help="cuda | cpu (default: auto-detect)")
    p.add_argument("--no-ocr", action="store_true", help="Disable OCR pass (icons only)")
    p.add_argument("--max-elements", type=int, default=100)
    p.add_argument("--health", action="store_true", help="Check model availability and exit")
    p.add_argument("--download", action="store_true", help="Download model weights and exit")
    return p.parse_args()


# ── Lazy deps ────────────────────────────────────────────────────────


def import_deps(need_full: bool) -> Dict[str, Any]:
    """Import only what's needed. `need_full` brings the heavy ML stack."""
    try:
        from PIL import Image  # type: ignore
    except ImportError:
        fail("Pillow not installed", hint="pip install Pillow")

    if not need_full:
        return {"Image": Image}

    missing: List[str] = []
    out: Dict[str, Any] = {"Image": Image}

    try:
        import torch  # type: ignore
        out["torch"] = torch
    except ImportError:
        missing.append("torch")

    try:
        from ultralytics import YOLO  # type: ignore
        out["YOLO"] = YOLO
    except ImportError:
        missing.append("ultralytics")

    try:
        from transformers import AutoProcessor, AutoModelForCausalLM  # type: ignore
        out["AutoProcessor"] = AutoProcessor
        out["AutoModelForCausalLM"] = AutoModelForCausalLM
    except ImportError:
        missing.append("transformers")

    if missing:
        fail(
            f"missing OmniParser deps: {', '.join(missing)}",
            hint="pip install -r requirements-omniparser.txt",
        )

    # OCR is optional — degrade gracefully if paddleocr isn't installed.
    try:
        from paddleocr import PaddleOCR  # type: ignore
        out["PaddleOCR"] = PaddleOCR
    except Exception:
        out["PaddleOCR"] = None

    return out


# ── Icon detector (isolated behind an interface) ─────────────────────
#
# §2.1 of the Cognitive Bridge spec: the ONLY AGPL-licensed piece of the
# OmniParser pipeline is the icon detector (Ultralytics YOLOv8). Everything
# else (Florence-2 caption = MIT, PaddleOCR = permissive) is safe to ship.
# We isolate the detector behind the `IconDetector` interface so it can be
# swapped for a permissively-licensed detector (e.g. a DETR/Apache model)
# WITHOUT touching the rest of the Vision Engine — the "escotilla de escape".
#
# Select the implementation via LUMINA_ICON_DETECTOR (default: "yolo").
# To add a permissive detector later: implement IconDetector.detect(...) in a
# new subclass and register it in `make_detector()` — nothing downstream
# changes because parse_image() only ever calls `detector.detect(...)`.


YOLO_WEIGHTS_FILENAME = "icon_detect.pt"
FLORENCE_REPO = "microsoft/Florence-2-base"


class IconDetector:
    """Interface: detect interactive UI boxes in a PIL image.

    Returns a list of raw box dicts: {"bbox": {x,y,w,h}, "center": {x,y},
    "confidence": float}. Caption/OCR are added downstream, so a detector
    only has to localize — it never needs the ML caption stack.
    """

    name: str = "abstract"
    license: str = "unknown"

    def detect(self, img: Any, max_elements: int) -> List[Dict[str, Any]]:
        raise NotImplementedError


class UltralyticsYoloDetector(IconDetector):
    """Microsoft OmniParser's fine-tuned YOLOv8 icon detector.

    ⚠️ AGPL-3.0 (Ultralytics). This is the single AGPL dependency of the
    pipeline; keep all AGPL surface confined to THIS class.
    """

    name = "yolo"
    license = "AGPL-3.0"

    def __init__(self, deps: Dict[str, Any]) -> None:
        weights_path = model_dir() / YOLO_WEIGHTS_FILENAME
        if not weights_path.exists():
            fail(
                f"OmniParser YOLO weights missing at {weights_path}",
                hint="Run `python omniparser.py --download` first.",
            )
        if "YOLO" not in deps:
            fail("ultralytics not installed", hint="pip install -r requirements-omniparser.txt")
        self._yolo = deps["YOLO"](str(weights_path))

    def detect(self, img: Any, max_elements: int) -> List[Dict[str, Any]]:
        results = self._yolo.predict(img, conf=0.25, iou=0.5, verbose=False)
        boxes_out: List[Dict[str, Any]] = []
        if not results:
            return boxes_out
        result = results[0]
        boxes = result.boxes if hasattr(result, "boxes") else None
        if boxes is None:
            return boxes_out
        xyxy = boxes.xyxy.cpu().numpy() if hasattr(boxes, "xyxy") else []
        confs = boxes.conf.cpu().numpy() if hasattr(boxes, "conf") else []
        for i, b in enumerate(xyxy[:max_elements]):
            x1, y1, x2, y2 = [int(v) for v in b]
            boxes_out.append({
                "bbox": {"x": x1, "y": y1, "w": x2 - x1, "h": y2 - y1},
                "center": {"x": (x1 + x2) // 2, "y": (y1 + y2) // 2},
                "confidence": float(confs[i]) if i < len(confs) else 0.0,
            })
        return boxes_out


def make_detector(deps: Dict[str, Any]) -> IconDetector:
    """Factory: pick the icon detector by LUMINA_ICON_DETECTOR. Add permissive
    detectors here to escape the AGPL surface without touching the pipeline."""
    choice = os.environ.get("LUMINA_ICON_DETECTOR", "yolo").strip().lower()
    if choice in ("yolo", "ultralytics", ""):
        return UltralyticsYoloDetector(deps)
    # Future: elif choice == "detr": return DetrIconDetector(deps)  # Apache/MIT
    fail(
        f"unknown LUMINA_ICON_DETECTOR={choice!r}",
        hint="Supported: yolo. Register new detectors in make_detector().",
    )
    raise RuntimeError("unreachable")  # fail() exits; keeps type-checkers happy


class OmniParserModel:
    """Singleton-style holder. Loaded once per process, reused across parses."""

    _instance: Optional["OmniParserModel"] = None

    def __init__(self, deps: Dict[str, Any], device: str) -> None:
        self.device = device
        # Detector is isolated behind IconDetector (§2.1). The pipeline below
        # never names YOLO/Ultralytics — swap detectors via LUMINA_ICON_DETECTOR.
        self.detector: IconDetector = make_detector(deps)
        florence_dir = model_dir() / "florence-2"
        if florence_dir.exists():
            self.processor = deps["AutoProcessor"].from_pretrained(str(florence_dir), trust_remote_code=True)
            self.florence = deps["AutoModelForCausalLM"].from_pretrained(
                str(florence_dir), trust_remote_code=True
            ).to(device)
        else:
            # Fall back to downloading from HuggingFace cache.
            self.processor = deps["AutoProcessor"].from_pretrained(FLORENCE_REPO, trust_remote_code=True)
            self.florence = deps["AutoModelForCausalLM"].from_pretrained(
                FLORENCE_REPO, trust_remote_code=True
            ).to(device)
        self.ocr = None
        if deps.get("PaddleOCR") is not None:
            try:
                self.ocr = deps["PaddleOCR"](use_angle_cls=False, lang="en", show_log=False)
            except Exception:
                self.ocr = None

    @classmethod
    def load(cls, deps: Dict[str, Any], device: str) -> "OmniParserModel":
        if cls._instance is None or cls._instance.device != device:
            cls._instance = cls(deps, device)
        return cls._instance


# ── Inference ────────────────────────────────────────────────────────


def parse_image(image_path: Path, device: str, use_ocr: bool, max_elements: int) -> Dict[str, Any]:
    deps = import_deps(need_full=True)
    model = OmniParserModel.load(deps, device)
    start = time.monotonic()
    img = deps["Image"].open(str(image_path)).convert("RGB")

    # 1) Detect icons / interactive boxes via the isolated detector (§2.1).
    #    The pipeline is detector-agnostic — it only consumes bbox/center/conf.
    elements: List[Dict[str, Any]] = []
    for box in model.detector.detect(img, max_elements):
        elements.append({
            "kind": "icon",
            "bbox": box["bbox"],
            "center": box["center"],
            "confidence": box.get("confidence", 0.0),
            "label": None,
            "interactivity": True,
        })

    # 2) Florence-2 captions per detected box.
    try:
        for elem in elements:
            x, y, w, h = elem["bbox"]["x"], elem["bbox"]["y"], elem["bbox"]["w"], elem["bbox"]["h"]
            if w < 8 or h < 8:
                continue
            crop = img.crop((x, y, x + w, y + h))
            inputs = model.processor(text="<CAPTION>", images=crop, return_tensors="pt").to(device)
            with deps["torch"].no_grad():
                gen = model.florence.generate(
                    input_ids=inputs["input_ids"],
                    pixel_values=inputs["pixel_values"],
                    max_new_tokens=24,
                    do_sample=False,
                    num_beams=2,
                )
            text = model.processor.batch_decode(gen, skip_special_tokens=True)[0]
            elem["label"] = text.strip()[:80] or None
    except Exception as e:
        # Captioning is best-effort; bboxes alone are still useful.
        for elem in elements:
            if "label" not in elem:
                elem["label"] = None
        elements_meta = {"captionError": str(e)}
    else:
        elements_meta = {}

    # 3) OCR pass for text regions (optional).
    text_elements: List[Dict[str, Any]] = []
    if use_ocr and model.ocr is not None:
        try:
            ocr_results = model.ocr.ocr(str(image_path), cls=False)
            if ocr_results and ocr_results[0]:
                for line in ocr_results[0][:max_elements]:
                    box, (text, conf) = line
                    if not text:
                        continue
                    xs = [p[0] for p in box]
                    ys = [p[1] for p in box]
                    x1, y1, x2, y2 = int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))
                    text_elements.append({
                        "kind": "text",
                        "bbox": {"x": x1, "y": y1, "w": x2 - x1, "h": y2 - y1},
                        "center": {"x": (x1 + x2) // 2, "y": (y1 + y2) // 2},
                        "confidence": float(conf),
                        "label": text[:160],
                        "interactivity": False,
                    })
        except Exception:
            pass

    duration_ms = int((time.monotonic() - start) * 1000)
    return {
        "ok": True,
        "device": device,
        "durationMs": duration_ms,
        "elements": elements + text_elements[: max_elements - len(elements)],
        "iconCount": len(elements),
        "textCount": len(text_elements),
        "meta": elements_meta,
    }


# ── Health + download commands ──────────────────────────────────────


def cmd_health(device: str) -> None:
    have_weights = (model_dir() / YOLO_WEIGHTS_FILENAME).exists()
    have_florence = (model_dir() / "florence-2").exists()
    have_torch = False
    try:
        import torch  # type: ignore
        have_torch = True
    except ImportError:
        pass
    detector_choice = os.environ.get("LUMINA_ICON_DETECTOR", "yolo").strip().lower() or "yolo"
    json.dump({
        "ok": True,
        "ready": have_weights and have_torch,
        "device": device,
        "modelDir": str(model_dir()),
        "detector": detector_choice,
        "haveYoloWeights": have_weights,
        "haveFlorenceLocal": have_florence,
        "haveTorch": have_torch,
    }, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


def cmd_download() -> None:
    """Lazy download: pull YOLO weights from HuggingFace into model_dir().
    Florence-2 is fetched on first use via transformers' hub cache."""
    try:
        from huggingface_hub import hf_hub_download  # type: ignore
    except ImportError:
        fail("huggingface_hub not installed", hint="pip install -r requirements-omniparser.txt")

    dest = model_dir()
    dest.mkdir(parents=True, exist_ok=True)
    downloaded: List[str] = []

    try:
        weights_path = hf_hub_download(
            repo_id="microsoft/OmniParser-v2.0",
            filename="icon_detect/model.pt",
            local_dir=str(dest),
            local_dir_use_symlinks=False,
        )
        # Normalize to expected name.
        target = dest / YOLO_WEIGHTS_FILENAME
        if Path(weights_path).resolve() != target.resolve():
            try:
                target.write_bytes(Path(weights_path).read_bytes())
            except Exception:
                pass
        downloaded.append(str(target))
    except Exception as e:
        fail(f"YOLO weight download failed: {e}",
             hint="Check internet, HF token if private. See microsoft/OmniParser on GitHub for alternate URLs.")

    json.dump({"ok": True, "downloaded": downloaded, "modelDir": str(dest)},
              sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


# ── Main ─────────────────────────────────────────────────────────────


def main() -> None:
    args = parse_args()

    if args.download:
        cmd_download()
        return

    device = args.device or default_device()

    if args.health:
        cmd_health(device)
        return

    if not args.image:
        fail("--image <path> is required (or use --health / --download)")

    image_path = Path(args.image).resolve()
    if not image_path.exists():
        fail(f"image not found: {image_path}")

    try:
        result = parse_image(image_path, device, use_ocr=not args.no_ocr, max_elements=args.max_elements)
        json.dump(result, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
    except SystemExit:
        raise
    except Exception as e:
        fail(f"parse failed: {e}\n{traceback.format_exc()}")


if __name__ == "__main__":
    main()
