"""
============================================================================
Drone Safety Platform -- TensorRT engine export script
----------------------------------------------------------------------------
Run ON the Jetson Orin Nano (inside the companion container) to fetch the
pretrained YOLO11n weights and bake them into an FP16 TensorRT ``.engine``
that ``PersonDetector`` picks up automatically.

Usage::

    python export_tensorrt.py [--model yolo11n.pt] [--out DIR] [--imgsz 640]
                              [--workspace 4]

Exit status is the contract: ``0`` only when an engine exists at the printed
path, ``1`` when ultralytics is missing or the export produced no locatable
engine.  Nothing is ever reported as a success on the strength of the export
call returning -- the file is looked for and confirmed.

Prerequisites
-------------
1. **JetPack 6.x** (tested on 6.0 / 6.1 for Orin Nano); TensorRT 8.6+ ships
   in the JetPack base image.
2. **ultralytics**::

       pip install ultralytics

   It pulls torch/torchvision; on JetPack the CUDA builds must match the
   JetPack release.  If the bundled torch conflicts with the JetPack one::

       pip install ultralytics --no-deps
       pip install onnx onnxruntime      # CPU-only runtime for the export

3. **TensorRT python bindings** ship with JetPack::

       python3 -c "import tensorrt; print(tensorrt.__version__)"

4. **Disk**: ~300 MB for the ``.pt`` plus ~80 MB for the ``.engine``.

Notes
-----
* FP16 (``half=True``) is used throughout: ~15-25 FPS at 640x640 on YOLO11n.
* The engine is bound to this exact TensorRT + GPU combination.  Re-export
  after a JetPack upgrade or a module swap.
* The final path is printed AND written to ``~/.config/eis/engine_path.txt``
  so other tooling can find it without being told.
* Point the companion at it with ``EIS_ENGINE_PATH`` (or pass
  ``engine_path=`` to ``PersonDetector``).

Typical result::

    /data/models/yolo11n_fp16.engine
============================================================================
"""

from __future__ import annotations

import argparse
import glob
import shutil
import sys
from pathlib import Path
from typing import Any, Optional, Sequence

DEFAULT_MODEL = "yolo11n.pt"
DEFAULT_IMGSZ = 640
DEFAULT_WORKSPACE_GIB = 4

#: Suffix appended to the weights stem, e.g. yolo11n -> yolo11n_fp16.engine
ENGINE_SUFFIX = "_fp16.engine"

#: Where the resulting path is recorded for other tools to discover.
POINTER_FILE = Path.home() / ".config" / "eis" / "engine_path.txt"


def build_parser() -> argparse.ArgumentParser:
    """CLI surface.  Flags and defaults are the script's contract."""
    parser = argparse.ArgumentParser(
        description=(
            "Download YOLO11n.pt and export it to an FP16 TensorRT .engine "
            "for the Jetson."
        )
    )
    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help=f"Model weights filename (default: {DEFAULT_MODEL}). "
             "Ultralytics downloads it to its cache on first use.",
    )
    parser.add_argument(
        "--out",
        default=str(Path.home() / "eis_models"),
        help="Output directory for the .engine file (created if absent).",
    )
    parser.add_argument(
        "--imgsz",
        type=int,
        default=DEFAULT_IMGSZ,
        help=f"Inference image size (square, default {DEFAULT_IMGSZ}). "
             "Larger sizes improve accuracy but reduce FPS.",
    )
    parser.add_argument(
        "--workspace",
        type=int,
        default=DEFAULT_WORKSPACE_GIB,
        help=f"TensorRT builder workspace in GiB (default {DEFAULT_WORKSPACE_GIB}). "
             "Reduce on devices with limited RAM.",
    )
    return parser


def engine_destination(out_dir: Path, model: str) -> Path:
    """Where the engine must end up: ``<out>/<model stem>_fp16.engine``."""
    return out_dir / f"{Path(model).stem}{ENGINE_SUFFIX}"


def _import_yolo() -> Optional[Any]:
    """Return ``ultralytics.YOLO``, or None after explaining the failure."""
    try:
        from ultralytics import YOLO  # type: ignore
    except ImportError:
        print(
            "ERROR: ultralytics is not installed.\n"
            "Run:  pip install ultralytics\n"
            "inside the companion container or on the Jetson directly.",
            file=sys.stderr,
        )
        return None
    return YOLO


def locate_engine(reported: Any, destination: Path, stem: str) -> Optional[Path]:
    """Find the engine ultralytics just produced.

    Candidates, in order of trust: the path the export call reported, the
    destination itself (some versions write straight there), then a recursive
    sweep of the working tree for ``<stem>*.engine``.  The first one that
    exists on disk wins -- a reported path that is not a file counts for
    nothing.
    """
    candidates: list[Path] = []
    if reported:
        candidates.append(Path(str(reported)))
    candidates.append(destination)
    candidates.extend(Path(hit) for hit in glob.glob(f"**/{stem}*.engine", recursive=True))

    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def place_engine(found: Path, destination: Path) -> Path:
    """Move *found* to *destination* unless it is already there."""
    if found.resolve() == destination.resolve():
        return destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(found), str(destination))
    print(f"[export_tensorrt] Moved engine {found} -> {destination}")
    return destination


def record_pointer(destination: Path, pointer: Path = POINTER_FILE) -> Path:
    """Write the engine path where other tooling looks for it."""
    pointer.parent.mkdir(parents=True, exist_ok=True)
    pointer.write_text(str(destination) + "\n", encoding="utf-8")
    return pointer


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)

    yolo_cls = _import_yolo()
    if yolo_cls is None:
        return 1

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    destination = engine_destination(out_dir, args.model)
    stem = Path(args.model).stem

    print(f"[export_tensorrt] Loading model: {args.model}")
    model = yolo_cls(args.model)   # downloads into the ultralytics cache if absent

    print(
        f"[export_tensorrt] Exporting to TensorRT FP16 engine "
        f"(imgsz={args.imgsz}, workspace={args.workspace} GiB)...\n"
        "This can take 5-15 minutes on the Jetson Orin Nano."
    )
    reported = model.export(
        format="engine",
        imgsz=args.imgsz,
        half=True,               # FP16
        device="cuda:0",
        workspace=args.workspace,
        simplify=True,           # ONNX simplify before the TRT conversion
        verbose=True,
    )

    found = locate_engine(reported, destination, stem)
    if found is None:
        print(
            "WARNING: Could not locate the exported engine file. "
            "Check ultralytics output above.",
            file=sys.stderr,
        )
        return 1

    destination = place_engine(found, destination)
    pointer = record_pointer(destination)
    print(f"[export_tensorrt] Engine path saved to:  {pointer}")

    print(
        f"\n[export_tensorrt] SUCCESS\n"
        f"  Engine : {destination}\n"
        f"\n"
        f"  To use it, set the environment variable:\n"
        f"    export EIS_ENGINE_PATH={destination}\n"
        f"  or pass engine_path='{destination}' to PersonDetector().\n"
        f"\n"
        f"  The .engine is device-specific: re-export if you change JetPack\n"
        f"  versions or replace the Jetson module."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
