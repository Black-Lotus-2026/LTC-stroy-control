"""All photo fallback tests use local generated images and MockTransport only."""

import asyncio
import base64
import json
from io import BytesIO

import httpx
import pytest
from PIL import Image
from pydantic import SecretStr

from app.services.photo_vlm import PhotoVLM, _photo


def photo(size=(64, 32)):
    out = BytesIO()
    Image.new("RGB", size, "blue").save(out, "PNG")
    return out.getvalue()


def envelope(items=None, **updates):
    obj = {
        "choices": [
            {
                "finish_reason": "stop",
                "message": {"content": json.dumps({"detections": items or []})},
            }
        ]
    }
    obj["choices"][0].update(updates)
    return obj


def detection(**updates):
    item = {"class": "excavator", "xyxy": [0.1, 0.2, 0.7, 0.9], "confidence": 0.8}
    item.update(updates)
    return item


def run(handler, contents=None, **kwargs):
    adapter = PhotoVLM(
        api_key=SecretStr("test-secret-marker"),
        transport=httpx.MockTransport(handler),
        **kwargs,
    )
    return asyncio.run(adapter.detect(contents if contents is not None else photo()))


def test_valid_request_and_exact_normalized_result():
    calls = []

    def handler(request):
        calls.append(request)
        assert str(request.url) == "https://openrouter.ai/api/v1/chat/completions"
        data = json.loads(request.content)
        assert data["model"] == "openai/gpt-4o-mini"
        assert "tools" not in data
        assert data["provider"]["require_parameters"] is True
        assert (
            len(
                data["response_format"]["json_schema"]["schema"]["properties"][
                    "detections"
                ]["items"]["properties"]["class"]["enum"]
            )
            == 25
        )
        url = data["messages"][1]["content"][1]["image_url"]["url"]
        image = Image.open(BytesIO(base64.b64decode(url.split(",")[1])))
        assert image.size == (64, 32)
        assert not image.getexif()
        return httpx.Response(200, json=envelope([detection()]))

    result = run(handler)
    assert len(calls) == 1 and result.status == "used"
    box = result.detections[0]
    assert (box.x1, box.y1, box.x2, box.y2) == (0.1, 0.2, 0.7, 0.9)
    assert box.raw_label == "excavator" and box.confidence == 0.8
    assert result.confidence_calibrated is False
    assert box.class_id == sorted(PhotoVLM().names).index("excavator")
    assert "test-secret-marker" not in repr(result)


@pytest.mark.parametrize(
    "settings", [dict(enabled=False), dict(api_key=""), dict(model="")]
)
def test_unavailable_never_decodes_or_requests(settings):
    def forbidden(request):
        raise AssertionError("network forbidden")

    args = {"api_key": "key", **settings}
    adapter = PhotoVLM(**args, transport=httpx.MockTransport(forbidden))
    assert asyncio.run(adapter.detect(b"not-an-image")).status == "unavailable"


@pytest.mark.parametrize("status", [301, 302, 401, 403, 429, 500])
def test_http_errors_no_redirect_retry_or_body_leak(status):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(
            status,
            text="private-path secret-marker",
            headers={"location": "https://untrusted.invalid"},
        )

    result = run(handler)
    assert result.status == "error" and result.detections == [] and len(calls) == 1
    assert "secret-marker" not in repr(result) and "private-path" not in repr(result)


@pytest.mark.parametrize(
    "item",
    [
        detection(class_="wrong"),
        detection(**{"class": "catalogue_loader"}),
        detection(xyxy=[-0.1, 0.2, 0.7, 0.9]),
        detection(xyxy=[0.8, 0.2, 0.7, 0.9]),
        detection(xyxy=[True, 0.2, 0.7, 0.9]),
        detection(xyxy=[float("nan"), 0.2, 0.7, 0.9]),
        detection(xyxy=[0.1, 0.2, 0.7]),
        detection(confidence=float("inf")),
        detection(confidence=True),
        detection(confidence=1.1),
    ],
)
def test_invalid_detection_fails_whole_response(item):
    result = run(lambda request: httpx.Response(200, json=envelope([detection(), item])))
    assert result.status == "error" and result.detections == []


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"choices": []},
        envelope(finish_reason="length"),
        {"choices": [{"finish_reason": "stop", "message": {"content": "not JSON"}}]},
        {
            "choices": [
                {"finish_reason": "stop", "message": {"content": "{}", "tool_calls": [1]}}
            ]
        },
        {
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {"content": "{}", "refusal": "refused"},
                }
            ]
        },
        {
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {"content": '{"detections":[],"detections":[]}'},
                }
            ]
        },
        envelope([detection()] * 33),
    ],
)
def test_bad_envelopes_and_truncation(body):
    assert run(lambda r: httpx.Response(200, json=body)).status == "error"


def test_empty_is_successful_empty_not_fake_count():
    result = run(lambda r: httpx.Response(200, json=envelope()))
    assert result.status == "empty" and not result.detections


def test_timeout_network_oversize_and_invalid_photo():
    def timeout(r):
        raise httpx.ReadTimeout("secret-marker")

    assert run(timeout).status == "timeout"

    def error(r):
        raise httpx.ConnectError("secret-marker")

    assert run(error).status == "error"
    assert (
        run(
            lambda r: httpx.Response(200, content=b"x" * 1025), max_response_bytes=1024
        ).status
        == "error"
    )

    def forbidden(r):
        raise AssertionError("invalid input must never be transmitted")

    assert run(forbidden, b"not image").status == "error"


def test_total_deadline_includes_provider_wait():
    async def handler(r):
        await asyncio.sleep(0.1)
        return httpx.Response(200, json=envelope())

    assert run(handler, timeout=0.01).status == "timeout"


def test_resize_applies_exif_orientation_and_strips_metadata():
    im = Image.new("RGB", (1600, 800), "red")
    exif = Image.Exif()
    exif[274] = 6
    exif[270] = "private-secret-description"
    src = BytesIO()
    im.save(src, "JPEG", exif=exif)
    uri = _photo(src.getvalue())
    output = base64.b64decode(uri.split(",")[1])
    with Image.open(BytesIO(output)) as image:
        assert image.size == (640, 1280)
        assert not image.getexif()
    assert b"private-secret-description" not in output and len(output) <= 1024**2


def test_animated_oversized_and_bad_configuration_rejected():
    first = Image.new("RGB", (2, 2), "red")
    out = BytesIO()
    first.save(
        out, "GIF", save_all=True, append_images=[Image.new("RGB", (2, 2), "blue")]
    )
    with pytest.raises(ValueError):
        _photo(out.getvalue())
    with pytest.raises(ValueError):
        _photo(b"a" * (20 * 1024**2 + 1))
    with pytest.raises(ValueError):
        PhotoVLM(allowed_classes=["excavator"])
    with pytest.raises(ValueError):
        PhotoVLM(timeout=float("nan"))


@pytest.mark.parametrize("size", [(20, 10), (1600, 800)])
def test_photo_pixels_match_api_rgba_conversion_and_orientation(size):
    from app.services.trained_detector import decode_image

    source = Image.new("RGBA", size, (220, 20, 30, 0))
    encoded = BytesIO()
    source.save(encoded, "PNG")
    contents = encoded.getvalue()
    outgoing = Image.open(BytesIO(base64.b64decode(_photo(contents).split(",")[1])))
    expected = decode_image(contents)
    expected.thumbnail((1280, 1280))
    assert outgoing.size == expected.size
    assert (
        max(
            abs(a - b)
            for a, b in zip(
                outgoing.getpixel((0, 0)), expected.getpixel((0, 0)), strict=True
            )
        )
        < 5
    )


@pytest.mark.parametrize(
    ("name", "code"),
    [("worker", "PERSON_WORKER"), ("hanging_head", "OBJECT_HANGING_HEAD")],
)
def test_special_codes_match_yolo_contract(name, code):
    result = run(
        lambda r: httpx.Response(200, json=envelope([detection(**{"class": name})]))
    )
    assert result.detections[0].canonical_code == code


def test_deeply_nested_provider_json_returns_controlled_error():
    deep = "[" * 1100 + "0" + "]" * 1100
    assert run(lambda r: httpx.Response(200, content=deep.encode())).status == "error"
    body = {"choices": [{"finish_reason": "stop", "message": {"content": deep}}]}
    assert run(lambda r: httpx.Response(200, json=body)).status == "error"


def test_conflicting_machine_hypotheses_keep_highest_original_box_score_and_class():
    best = detection(
        **{"class": "backhoe_loader", "confidence": 0.91, "xyxy": [0.1, 0.1, 0.8, 0.9]}
    )
    items = [
        detection(
            **{"class": "loader", "confidence": 0.8, "xyxy": [0.12, 0.11, 0.79, 0.88]}
        ),
        best,
        detection(
            **{
                "class": "crane_manipulator",
                "confidence": 0.7,
                "xyxy": [0.11, 0.1, 0.8, 0.89],
            }
        ),
    ]
    result = run(lambda r: httpx.Response(200, json=envelope(items)))
    assert result.status == "used" and len(result.detections) == 1
    kept = result.detections[0]
    assert kept.raw_label == "backhoe_loader" and kept.confidence == 0.91
    assert [kept.x1, kept.y1, kept.x2, kept.y2] == best["xyxy"]


def test_worker_inside_machine_keeps_own_visible_box_and_score():
    items = [
        detection(
            **{
                "class": "backhoe_loader",
                "confidence": 0.93,
                "xyxy": [0.1, 0.1, 0.9, 0.9],
            }
        ),
        detection(
            **{"class": "worker", "confidence": 0.72, "xyxy": [0.4, 0.3, 0.5, 0.6]}
        ),
    ]
    result = run(lambda r: httpx.Response(200, json=envelope(items)))
    assert result.status == "used" and len(result.detections) == 2
    worker = next(d for d in result.detections if d.raw_label == "worker")
    assert worker.confidence == 0.72 and worker.canonical_code == "PERSON_WORKER"
    assert [worker.x1, worker.y1, worker.x2, worker.y2] == [0.4, 0.3, 0.5, 0.6]
