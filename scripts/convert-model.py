# Converts an upscaling model's PyTorch weights (any architecture spandrel reads: SPAN, Real-ESRGAN's RRDBNet, ...) to the ONNX file the app runs:
#   python scripts/convert-model.py WEIGHTS.(pth|safetensors) OUT.onnx
# Input `input` float32 [1, 3, H, W] (RGB 0..1), output `output` [1, 3, H*scale, W*scale]; opset 17. The tools' versions are in models/manifest.json.
# Checks the ONNX file against PyTorch on a random picture when onnxruntime is installed.
import sys, torch, onnx, numpy as np
from spandrel import ModelLoader
src, dst = sys.argv[1], sys.argv[2]
desc = ModelLoader().load_from_file(src)
print('architecture', desc.architecture.name, 'scale', desc.scale, 'in', desc.input_channels, 'out', desc.output_channels)
model = desc.model.eval()
x = torch.rand(1, 3, 64, 80)
with torch.no_grad():
    y = model(x)
print('torch output', tuple(y.shape), float(y.min()), float(y.max()))
torch.onnx.export(model, x, dst, input_names=['input'], output_names=['output'],
                  dynamic_axes={'input': {2: 'h', 3: 'w'}, 'output': {2: 'H', 3: 'W'}}, opset_version=17, dynamo=False)
onnx.checker.check_model(onnx.load(dst))
try:
    import onnxruntime as ort
    x2 = torch.rand(1, 3, 96, 128)
    with torch.no_grad():
        ref = model(x2).numpy()
    got = ort.InferenceSession(dst, providers=['CPUExecutionProvider']).run(None, {'input': x2.numpy()})[0]
    print('onnx output', got.shape, 'largest difference from torch', float(np.abs(got - ref).max()))
except ImportError:
    print('(onnxruntime not installed: not compared)')
print('saved', dst)
