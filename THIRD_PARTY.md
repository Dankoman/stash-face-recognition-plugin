# Packaged components

- **ONNX Runtime Web 1.24.3**, Microsoft, MIT. The package includes `assets/runtime/LICENSE`. Source: https://github.com/microsoft/onnxruntime/tree/v1.24.3
- **SCRFD det_10g and ArcFace w600k_r50**, InsightFace buffalo_l, copied from the user's existing local installation. InsightFace's pretrained model zoo is provided for non-commercial research purposes only; those model terms are separate from ONNX Runtime's MIT license. Source: https://github.com/deepinsight/insightface/tree/master/model_zoo
- **embeddings.bin and labels.json**, a local snapshot of the user's existing trained gallery. These contain identity/recognition data and are excluded from Git and public distribution by default.

The locally built ZIP includes the selected models and gallery. It is a private experimental artifact, not a published release.
