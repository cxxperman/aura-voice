# Exports RVC's v2 base generators to ONNX the way RVC's own exporter does
# (infer/modules/onnx/export.py at tag 2.2.231006), then runs each once to prove it works.
import json
import sys

import numpy as np
import torch

sys.path.insert(0, "rvc")
import infer.lib.infer_pack.models_onnx as models_onnx  # noqa: E402
from infer.lib.infer_pack.models_onnx import SynthesizerTrnMsNSFsidM  # noqa: E402


# At this tag the flow layers return (x, logdet) pairs — they were retyped for TorchScript — but
# the ONNX model's coupling block still expects a bare tensor, so the official exporter fails.
# The arithmetic is untouched; only the pair is unpacked.
def _coupling_forward(self, x, x_mask, g=None, reverse=False):
    for flow in (reversed(self.flows) if reverse else self.flows):
        out = flow(x, x_mask, g=g, reverse=reverse)
        x = out[0] if isinstance(out, tuple) else out
    return x


models_onnx.ResidualCouplingBlock.forward = _coupling_forward


def export(config_path, weights_path, out_path):
    c = json.load(open(config_path))
    d, m, t = c["data"], c["model"], c["train"]
    ck = torch.load(weights_path, map_location="cpu")
    state = ck["model"] if "model" in ck else ck.get("weight", ck)
    weight = {k: v.float() for k, v in state.items() if "enc_q" not in k}  # the posterior encoder is for training only
    config = [
        d["filter_length"] // 2 + 1, t["segment_size"] // d["hop_length"], m["inter_channels"], m["hidden_channels"],
        m["filter_channels"], m["n_heads"], m["n_layers"], m["kernel_size"], m["p_dropout"], m["resblock"],
        m["resblock_kernel_sizes"], m["resblock_dilation_sizes"], m["upsample_rates"], m["upsample_initial_channel"],
        m["upsample_kernel_sizes"], weight["emb_g.weight"].shape[0], m["gin_channels"], d["sampling_rate"],
    ]
    net = SynthesizerTrnMsNSFsidM(*config, is_half=False, version="v2")
    print(out_path, "load:", net.load_state_dict(weight, strict=False))
    net.eval()
    T = 200
    args = (torch.rand(1, T, 768), torch.tensor([T]).long(), torch.randint(size=(1, T), low=5, high=255),
            torch.rand(1, T), torch.LongTensor([0]), torch.rand(1, 192, T))
    torch.onnx.export(
        net, args, out_path,
        dynamic_axes={"phone": [1], "pitch": [1], "pitchf": [1], "rnd": [2]},
        do_constant_folding=False, opset_version=13, verbose=False,
        input_names=["phone", "phone_lengths", "pitch", "pitchf", "ds", "rnd"], output_names=["audio"],
    )
    # What a converter has to reproduce: every weight's name and shape, and the config.
    json.dump({"config": config, "speakers": int(weight["emb_g.weight"].shape[0]),
               "weights": {k: list(v.shape) for k, v in weight.items()}}, open(out_path + ".json", "w"))
    return d["sampling_rate"], int(weight["emb_g.weight"].shape[0])


def check(out_path, rate, speakers):
    import onnx
    import onnxruntime as ort

    model = onnx.load(out_path)
    inits = [i.name for i in model.graph.initializer]
    print(out_path, "initializers:", len(inits), "| named like the weights:", sum(1 for n in inits if not n.startswith("onnx::")), "| first:", inits[:6])
    s = ort.InferenceSession(out_path, providers=["CPUExecutionProvider"])
    print(" inputs:", [(i.name, i.type, i.shape) for i in s.get_inputs()], "| outputs:", [(o.name, o.shape) for o in s.get_outputs()])
    T = 200  # the traced graph fixes the length it was exported with: two seconds
    rng = np.random.default_rng(1)
    feed = {
        "phone": rng.standard_normal((1, T, 768)).astype(np.float32) * 0.3,
        "phone_lengths": np.array([T], dtype=np.int64),
        "pitch": np.full((1, T), 40, dtype=np.int64),
        "pitchf": np.full((1, T), 150.0, dtype=np.float32),
        "rnd": rng.standard_normal((1, 192, T)).astype(np.float32),
    }
    outs = []
    for sid in [0, 1, min(50, speakers - 1), speakers - 1]:
        y = s.run(None, {**feed, "ds": np.array([sid], dtype=np.int64)})[0]
        outs.append(y.reshape(-1))
        print(f" speaker {sid}: output shape {y.shape}, {y.size / T * 100:.0f} samples a second (expect {rate}), rms {float(np.sqrt((y ** 2).mean())):.4f}, finite {bool(np.isfinite(y).all())}")
    print(" speakers differ from speaker 0 by rms:", [round(float(np.sqrt(((o - outs[0]) ** 2).mean())), 4) for o in outs[1:]])


for name, cfg in [("f0G40k", "rvc/configs/v1/40k.json"), ("f0G48k", "rvc/configs/v2/48k.json")]:
    out = f"out/rvc-v2-base-{name[3:]}.onnx"
    rate, speakers = export(cfg, f"base/{name}.pth", out)
    check(out, rate, speakers)
