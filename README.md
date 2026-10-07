# Face Recognition Plugin 3.0.3

A standalone Stash plugin that runs face analysis directly in the browser. The ZIP includes JavaScript, WebAssembly, SCRFD/ArcFace models and a packaged recognition database. No Go service, Python installation, CDN or separate analysis server is required to use the plugin.

## Usage

1. Open a scene and select **Edit**. The Identify button appears only there.
2. Play the video and pause at the frame you want to analyze.
3. Click **Identify**. Hover over the face box to display the results list with candidate images and confidence scores.
4. Select a suggestion to add the performer to the scene. Settings control automatic linking and the creation of new performers.
5. Right-click the button to open settings and **Test analysis engine**.

The button does not appear on Details, other scene tabs or Settings. No floating button is created. **Max suggestions (top-K)** controls how many candidates appear with individual previews. Suggestions below **Minimum confidence** remain visible and are labeled **Uncertain suggestion**. If an image is unavailable, **No image available** is shown and the candidate can still be selected. Larger previews appear beside the active suggestion and close after selection, when hovering ends, on navigation or when the results are removed.

## Analysis

A background worker loads models from the plugin's own Stash URLs. `auto` tries WebGPU and falls back to CPU/WebAssembly when a GPU is unavailable or the model cannot run on it. `cpu` forces CPU execution. The engine test runs both models before reporting readiness. The GPU on the computer running the browser is used. The same package works on Windows and Linux; GPU support depends on the browser and drivers.

Initial requests include model loading. The engine is reused afterward, and a timeout terminates the worker to release resources. Models run without requiring SharedArrayBuffer, COOP/COEP, CUDA or ROCm. Video frames are not sent to an analysis server.

Matching uses exported 512-dimensional embeddings and cosine distance, with the same weighted neighbor voting and score mapping as the Go version. Coordinates are mapped back to the original image. Alignment uses a similarity transform with the same reference points; numerically identical results to OpenCV/RANSAC are not guaranteed.

## Metadata and images

The plugin uses Stash's native GraphQL lookups for configured Stash-box sources: StashDB, ThePornDB, PMVStash and FansDB. It does not request API keys. Configure your sources under **Settings → Metadata Providers → Stash-Box Endpoints**; no separate scrapers need to be installed.

Select **All** under **Metadata source** to search in this order: **StashDB → TPDB → PMVStash → FansDB**. The first unambiguous match is used, and later sources are not queried. Unconfigured sources are skipped. A provider error or ambiguous match allows the search to continue with the next source. If no unambiguous match is found, provider errors are reported. Other choices try the selected primary source first, followed by the other configured sources. Exact names or aliases are required. Existing performers are matched using their saved external IDs to avoid confusing people with the same name. A performer already attached to the scene requires no metadata lookup. Ambiguous matches without a saved identity are rejected. A provider error is distinguished from a successful search with no match, so an error does not create a name-only performer. Supported metadata fields accepted by Stash are included in the import. Stash downloads images during creation or updates, avoiding browser CORS issues. Enrichment preserves populated local fields and requires the same external identity.

## Installation

See [INSTALLATION.md](INSTALLATION.md). Install or upgrade through Stash using `main/index.yml` as the plugin source. GitHub release 3.0.3 includes the complete ZIP with models, runtime and recognition data.

## Verification

```sh
node --check face-recognition.js
node --check standalone-browser.js
node --check assets/recognition-worker.js
node --test tests/*.test.cjs
```

`tests/browser-smoke.html` runs the actual packaged models on synthetic media, including under a CSP that permits WebAssembly but not general JavaScript eval. `tests/ui-placement.html` checks button placement using Stash's observed DOM structure. The test server and Node/Python are used only during development.

Verified in Chrome/Linux: models run on CPU, paused video analysis works, existing performers can be selected without ambiguous name searches, and previews appear beside suggestions and disappear after selection. The button appears only in Edit. The 64 automated tests also cover metadata import, settings, the worker and delayed preview loading.

Windows, AMD/Nvidia acceleration, broader recognition accuracy and complete metadata import against live providers have not yet been verified. WebGPU support depends on the browser and drivers; CPU/WebAssembly is used as a fallback.
