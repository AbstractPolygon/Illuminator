# Halves the size of an ONNX model by storing its float32 weights as float16, each followed by a Cast back to float32:
#   python scripts/halve-weights.py IN.onnx OUT.onnx
# The math stays at 32 bits, so the file runs on every ONNX Runtime backend (WebGPU, WebAssembly) with no half precision support needed; only the weights are rounded.
import sys, numpy as np, onnx
from onnx import numpy_helper, helper, TensorProto
m = onnx.load(sys.argv[1])
g = m.graph
inits, casts = [], []
for t in g.initializer:
    arr = numpy_helper.to_array(t) if t.data_type == TensorProto.FLOAT else None
    if arr is None or arr.size < 16:
        inits.append(t)
        continue
    half = numpy_helper.from_array(arr.astype(np.float16), t.name + '_f16')
    inits.append(half)
    casts.append(helper.make_node('Cast', [half.name], [t.name], to=TensorProto.FLOAT, name='cast_' + t.name))
nodes = list(g.node)
del g.initializer[:]
g.initializer.extend(inits)
del g.node[:]
g.node.extend(casts + nodes)
onnx.checker.check_model(m)
onnx.save(m, sys.argv[2])
print('halved', len(casts), 'weights; saved', sys.argv[2])
