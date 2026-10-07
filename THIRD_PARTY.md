# Packaged components

- **ONNX Runtime Web 1.24.3**, Microsoft, MIT. The package includes `assets/runtime/LICENSE`. Source: https://github.com/microsoft/onnxruntime/tree/v1.24.3
- **SCRFD det_10g and ArcFace w600k_r50**, InsightFace buffalo_l, copied from the user's existing local installation. InsightFace's pretrained model zoo is provided for non-commercial research purposes only; those model terms are separate from ONNX Runtime's MIT license. Source: https://github.com/deepinsight/insightface/tree/master/model_zoo
- **embeddings.bin and labels.json**, a snapshot of the user's existing trained gallery containing 24,359 identity labels and biometric face vectors. The user explicitly authorized publication of the complete package in this public repository. The data are excluded from source control and included in the release ZIP.

The public release ZIP includes the models, ONNX Runtime files and gallery. Model usage terms still apply separately from the plugin and runtime code licenses.
