"""Read-only OpenRouter credential check. Never generate tokens or print a secret."""

import json

import httpx

from app.core.config import settings


def main() -> int:
    key = settings.openrouter_api_key.get_secret_value()
    if not key:
        print(json.dumps({"status": "provider_unavailable", "key_present": False}))
        return 1
    try:
        with httpx.Client(
            timeout=httpx.Timeout(10, connect=3), follow_redirects=False
        ) as c:
            response = c.get(
                "https://openrouter.ai/api/v1/key",
                headers={"Authorization": "Bearer " + key},
            )
        if response.status_code != 200:
            print(
                json.dumps(
                    {"status": "key_check_failed", "http_status": response.status_code}
                )
            )
            return 1
        data = response.json().get("data")
        if not isinstance(data, dict):
            raise ValueError("invalid response")
        management = (
            data.get("is_management_key") is True
            or data.get("is_provisioning_key") is True
        )
        print(
            json.dumps(
                {
                    "status": "management_key_cannot_generate"
                    if management
                    else "inference_key_recognized",
                    "is_management_key": management,
                    "generation_tested": False,
                }
            )
        )
        return 2 if management else 0
    except (httpx.HTTPError, ValueError, TypeError, AttributeError):
        print(json.dumps({"status": "key_check_unavailable"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
