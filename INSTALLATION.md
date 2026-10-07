# Installing Face Recognition 3.0.3

## Install and update through Stash

1. Open **Settings → Plugins** and add or edit the **Dankoman Final Face** plugin source.
2. Use the source URL `https://raw.githubusercontent.com/Dankoman/stash-face-recognition-plugin/main/index.yml`.
3. Install **Face Recognition Plugin**, or select the package and update it.
4. Reload the browser page. Right-click **Identify** on a scene's **Edit** tab and select **Test analysis engine**.

The package contains all analysis files. No separate service or runtime installation is required. If you are upgrading from the experimental branch, install the package from the main source so that future upgrades use it.

## Manually install the complete plugin package

1. Back up the installed plugin folder and its settings.
2. Extract `face-recognition-3.0.3.zip` from GitHub release 3.0.3 into the existing `face-recognition` plugin folder. Keep `assets/` and its subdirectories; they contain all analysis files.
3. Click **Reload plugins** in Stash and reload the browser page.
4. Open a scene, select **Edit**, right-click **Identify** and select **Test analysis engine**.
5. Check analysis on a paused frame and confirm that no Identify button appears on Details or Settings.

The plugin does not start an external process or use `/face-api`. The old API URL setting is ignored. Existing functional settings are preserved; the old API timeout is replaced with 180 seconds on the first load because models now load in the browser.

For metadata, configure the sources you want under Stash's **Settings → Metadata Providers → Stash-Box Endpoints**. Existing keys in the StashAPI environment file are not automatically migrated to Stash. The plugin does not read keys and can run analysis without external metadata sources. Each provider's usual account or API key is still required for external metadata.

## Metadata source

Select **All (StashDB → TPDB → PMVStash → FansDB)** in the plugin settings panel to use the first unambiguous match from the sources in that order. In Stash's generic plugin settings, enter `all` for the same option (the legacy value `alla` is also accepted). Sources must be configured under **Metadata Providers**.

## Updates and rollback

Replace the complete plugin package and reload plugins and the browser page after an update. The recognition database is a snapshot included in the package: new training results must be packaged as an update. The plugin does not read a live Python pickle or Go export directory on the server.

Restore the backed-up plugin folder and settings to return to 2.4.2. The Go service is required only if you return to the old version.

## Build the package (developers only)

Python and npm are required only on the build computer. End users install the ZIP package.

- Download `onnxruntime-web@1.24.3` from npm using `npm pack`.
- Place `ort.webgpu.bundle.min.mjs`, both `ort-wasm-simd-threaded.jsep.*` files, both `ort-wasm-simd-threaded.asyncify.*` files and the ONNX Runtime MIT license in `assets/runtime/`.
- Place `det_10g.onnx` and `w600k_r50.onnx` from the existing buffalo_l installation in `assets/models/`.
- Place `embeddings.bin` and `labels.json` from your existing export in `assets/gallery/`.
- Run `python tools/build-package.py`. Optional flags: `--models`, `--gallery`, `--runtime`, `--output`.

The builder verifies the database size, creates a file manifest with SHA-256 hashes, checks ZIP integrity and writes a separate checksum. Generated models, recognition data, runtime files and packages are ignored by Git. The complete package is published separately as a GitHub release; the code and builder are on main.

## Troubleshooting

- **Missing plugin file:** install the complete ZIP contents, including `assets/`.
- **Model initialization/CSP error:** check that the plugin CSP has loaded after Reload plugins. WebAssembly requires `wasm-unsafe-eval`; the worker starts through a blob URL and requires `worker-src blob:`.
- **Slow analysis:** the engine test reports the active backend. CPU works without additional software but may be slower than GPU.
- **Missing metadata source:** configure Stash-box in Stash, not in the Go service.
- **Empty results:** try a clearer paused frame; an empty image produces an empty results list.

Windows, AMD/Nvidia GPUs and complete metadata import against live providers have not yet been verified. Chrome/Linux, CPU analysis, existing performer linking and previews have been tested in Stash.
