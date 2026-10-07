#!/usr/bin/env python3
"""Build a self-contained plugin ZIP; Python is a build tool, not a runtime dependency."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parent.parent
RUNTIME = ["ort.webgpu.bundle.min.mjs", "ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm", "ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm", "LICENSE"]
SOURCES = ["face-recognition.js", "standalone-browser.js", "face-recognition.css", "face-recognition.yml", "README.md", "INSTALLATION.md", "THIRD_PARTY.md", "assets/recognition-core.js", "assets/recognition-worker.js"]

def build():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--models", type=Path, default=ROOT / "assets/models")
    parser.add_argument("--gallery", type=Path, default=ROOT / "assets/gallery")
    parser.add_argument("--runtime", type=Path, default=ROOT / "assets/runtime")
    parser.add_argument("--output", type=Path, default=ROOT / "dist/face-recognition-3.0.0-dev.3.zip")
    args = parser.parse_args()
    files = {name: ROOT / name for name in SOURCES}
    files.update({"assets/runtime/" + name: args.runtime / name for name in RUNTIME})
    files.update({"assets/models/" + name: args.models / name for name in ["det_10g.onnx", "w600k_r50.onnx"]})
    files.update({"assets/gallery/" + name: args.gallery / name for name in ["embeddings.bin", "labels.json"]})
    missing = [str(path) for path in files.values() if not path.is_file()]
    if missing:
        parser.error("Missing package inputs: " + ", ".join(missing))
    labels = json.loads((args.gallery / "labels.json").read_text())
    if not labels or any(not isinstance(name, str) or not name for name in labels):
        parser.error("labels.json must contain a nonempty list of identity names")
    if (args.gallery / "embeddings.bin").stat().st_size != len(labels) * 512 * 4:
        parser.error("embeddings.bin must contain one 512-dimensional float32 row per label")
    manifest = {"version": "3.0.0-dev.3", "runtime": "onnxruntime-web@1.24.3", "samples": len(labels), "files": {}}
    for name, path in files.items():
        manifest["files"][name] = {"bytes": path.stat().st_size, "sha256": hashlib.file_digest(path.open('rb'), 'sha256').hexdigest()}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(args.output, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for name, path in files.items():
            archive.write(path, name)
        archive.writestr("assets/manifest.json", json.dumps(manifest, indent=2))
    with zipfile.ZipFile(args.output) as archive:
        failure = archive.testzip()
        if failure:
            raise RuntimeError("ZIP validation failed: " + failure)
    digest = hashlib.file_digest(args.output.open('rb'), 'sha256').hexdigest()
    args.output.with_suffix('.sha256').write_text(digest + '  ' + args.output.name + '\n')
    print(f"{args.output}\n{args.output.stat().st_size / 1024**2:.1f} MiB\nSHA-256 {digest}")

if __name__ == "__main__":
    build()
