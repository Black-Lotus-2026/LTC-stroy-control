"""Decode reviewed partial24/28 channels; CLI loads trusted deployment bundles only.

Raw training channels and source scopes survive semantic NMS. Fine classes
require explicit real head channels; initialized expansion weights are rejected.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Backend core is packaged independently for production; repo CLI shares it.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from app.services.construction_partial import (
    ConstructionPartial,
    decode_partial_result,
    ordered_names,
    reviewed_contract,
)


def decode_result(result, yolo, nms_iou=0.55, proposal_iou=0.5, *, mapping=None):
    """Pure already-produced tensor decoder, NOT model-loading/authorization API.

    A subset of reviewed channels is allowed for tensor unit tests. Runtime
    inference must use ConstructionPartial, which validates the complete bundle.
    Target28 pure decoding also requires its explicit reviewed mapping.
    """
    if mapping is None:
        mapping = json.loads(
            (
                Path(__file__).resolve().parents[1]
                / "data/construction/semantic-mapping.json"
            ).read_text()
        )
    if isinstance(mapping, (str, Path)):
        mapping = json.loads(Path(mapping).read_text())
    contract = reviewed_contract(mapping)
    model = yolo.model
    names = ordered_names(model.names)
    expected = {name: contract["decoder"].get(name) for name in names}
    if getattr(model, "training_to_semantic", None) != expected or any(
        v is None for v in expected.values()
    ):
        raise ValueError(
            "Checkpoint decoder differs from explicitly reviewed channel semantics"
        )
    if getattr(yolo, "ckpt", {}).get("initialization_only") is True:
        raise ValueError("Initialization-only checkpoint is not an inference model")
    return decode_partial_result(
        result, model.names, contract, nms_iou=nms_iou, proposal_iou=proposal_iou
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument(
        "--weights-sha256",
        required=True,
        help="Independently trusted own checkpoint SHA before deserialization",
    )
    parser.add_argument("--mapping", type=Path, required=True)
    parser.add_argument("--deployment-manifest", type=Path, required=True)
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--imgsz", type=int, default=960)
    parser.add_argument("--confidence", type=float, default=0.2)
    parser.add_argument(
        "--parent-support-iou",
        type=float,
        help="Optional research child-proposal filter; raw and ungated outputs retained",
    )
    args = parser.parse_args()
    if args.output.exists() or args.output.resolve() in {
        p.resolve()
        for p in (args.image, args.weights, args.mapping, args.deployment_manifest)
    }:
        parser.error("Output must be new and must not replace an input artifact")
    from PIL import Image

    model = ConstructionPartial(
        args.weights,
        args.weights_sha256,
        args.mapping,
        args.deployment_manifest,
        device=args.device,
        parent_support_iou=args.parent_support_iou,
    )
    with Image.open(args.image) as image:
        result = model.predict(
            image.convert("RGB"), confidence=args.confidence, imgsz=args.imgsz
        )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(result.to_dict(), ensure_ascii=False, indent=2) + "\n"
    )


if __name__ == "__main__":
    main()
