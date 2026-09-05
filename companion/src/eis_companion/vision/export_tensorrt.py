"""
============================================================================
Eye in the Sky -- TensorRT engine export script
----------------------------------------------------------------------------
Run this script ON the Jetson Orin Nano (inside the companion Docker container)
to download the pretrained YOLO11n weights and export them to a FP16 TensorRT
.engine file that PersonDetector loads automatically.

Usage::

    python export_tensorrt.py [--model yolo11n.pt] [--out /data/models] [--imgsz 640]

Prerequisites (JetPack / TensorRT)
------------------------------------
1. **JetPack 6.x** (tested on JetPack 6.0 / 6.1 for Orin Nano).
   TensorRT 8.6+ is included in the JetPack base image.

2. **ultralytics** package::

       pip install ultralytics

   The package pulls torch/torchvision automatically; on JetPack the CUDA
   versions must match your JetPack release.  If ultralytics' bundled torch
   conflicts with the JetPack-provided torch, install ultralytics with::

       pip install ultralytics --no-deps
       pip install onnx onnxruntime  # CPU-only runtime for export

3. **TensorRT Python bindings** are included with JetPack::

       # verify:
       python3 -c "import tensorrt; print(tensorrt.__version__)"

4. **Disk space**: ~300 MB for the .pt weights + ~80 MB for the .engine.

Export notes
------------
* We export with ``half=True`` (FP16) for maximum throughput on Orin Nano.
  FP16 typically gives 15–25 FPS at 640×640 on YOLO11n.
* The engine is locked to the specific TensorRT + GPU combination on this
  device.  Re-export if you change JetPack versions or swap the module.
* The exported ``.engine`` path is printed to stdout and also written to
  ``~/.config/eis/engine_path.txt`` so other tools can find it automatically.
* Set the ``EIS_ENGINE_PATH`` environment variable (or pass the printed path
  to PersonDetector) to use the engine.

Typical output path::

    /data/models/yolo11n_fp16.engine

============================================================================
"""

import argparse
import sys
from pathlib import Path


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download YOLO11n.pt and export to a FP16 TensorRT .engine for the Jetson."
    )
    parser.add_argument(
        "--model",
        default="yolo11n.pt",
        help="Model weights filename (default: yolo11n.pt). "
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
        default=640,
        help="Inference image size (square, default 640). "
             "Larger sizes improve accuracy but reduce FPS.",
    )
    parser.add_argument(
        "--workspace",
        type=int,
        default=4,
        help="TensorRT builder workspace in GiB (default 4). "
             "Reduce on devices with limited RAM.",
    )
    return parser.parse_args()


def main() -> None:
    args = _parse_args()

    # ---- Check ultralytics availability ----------------------------------
    try:
        from ultralytics import YOLO  # type: ignore
    except ImportError:
        print(
            "ERROR: ultralytics is not installed.\n"
            "Run:  pip install ultralytics\n"
            "inside the companion container or on the Jetson directly.",
            file=sys.stderr,
        )
        sys.exit(1)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    # Stem for the output file: yolo11n_fp16.engine
    stem = Path(args.model).stem
    engine_name = f"{stem}_fp16.engine"
    engine_path = out_dir / engine_name

    print(f"[export_tensorrt] Loading model: {args.model}")
    model = YOLO(args.model)  # downloads to ultralytics cache if absent

    print(
        f"[export_tensorrt] Exporting to TensorRT FP16 engine "
        f"(imgsz={args.imgsz}, workspace={args.workspace} GiB)...\n"
        "This can take 5–15 minutes on the Jetson Orin Nano."
    )

    # ultralytics export API
    exported_path = model.export(
        format="engine",
        imgsz=args.imgsz,
        half=True,               # FP16
        device="cuda:0",
        workspace=args.workspace,
        simplify=True,           # ONNX simplify before TRT conversion
        verbose=True,
    )

    # ultralytics places the .engine next to the .pt by default; move/copy
    # to the requested output directory.
    if exported_path and Path(str(exported_path)).exists():
        src = Path(str(exported_path))
        dst = engine_path
        if src != dst:
            import shutil
            shutil.move(str(src), str(dst))
            print(f"[export_tensorrt] Moved engine to: {dst}")
    else:
        # Export may have already placed it in out_dir
        if not engine_path.exists():
            # Try to find it next to the .pt in the ultralytics cache
            import glob
            candidates = glob.glob(f"**/{stem}*.engine", recursive=True)
            if candidates:
                import shutil
                shutil.move(candidates[0], str(engine_path))
                print(f"[export_tensorrt] Moved engine from {candidates[0]} to {engine_path}")
            else:
                print(
                    "WARNING: Could not locate the exported engine file. "
                    "Check ultralytics output above.",
                    file=sys.stderr,
                )
                sys.exit(1)

    # ---- Write the path to a config file so the companion can find it ----
    config_dir = Path.home() / ".config" / "eis"
    config_dir.mkdir(parents=True, exist_ok=True)
    path_file = config_dir / "engine_path.txt"
    path_file.write_text(str(engine_path) + "\n", encoding="utf-8")
    print(f"[export_tensorrt] Engine path saved to:  {path_file}")

    print(
        f"\n[export_tensorrt] SUCCESS\n"
        f"  Engine : {engine_path}\n"
        f"\n"
        f"  To use it, set the environment variable:\n"
        f"    export EIS_ENGINE_PATH={engine_path}\n"
        f"  or pass engine_path='{engine_path}' to PersonDetector().\n"
        f"\n"
        f"  The .engine is device-specific: re-export if you change JetPack\n"
        f"  versions or replace the Jetson module."
    )


if __name__ == "__main__":
    main()
