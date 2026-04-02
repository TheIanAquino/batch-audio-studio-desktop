#!/usr/bin/env python3
from __future__ import annotations

import base64
import json
import mimetypes
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable

from batch_audio_core import DEFAULT_TIMEOUT_SECONDS, decode_audio_payload, request_json


class VoiceCloneClient:
    def __init__(
        self,
        *,
        request_json_fn: Callable[[str, str, dict[str, Any] | None, int], dict[str, Any]] | None = None,
        timeout: int = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        self.request_json_fn = request_json_fn or self._default_request
        self.timeout = timeout

    def upload_reference_audio(self, api_base: str, audio_path: Path) -> dict[str, Any]:
        path = Path(audio_path).expanduser().resolve()
        payload = {
            "filename": path.name,
            "content_type": mimetypes.guess_type(path.name)[0] or "application/octet-stream",
            "file_base64": base64.b64encode(path.read_bytes()).decode("ascii"),
        }
        if self._supports_json_upload(api_base):
            return self.request_json_fn("POST", self._url(api_base, "api/v1/base/upload-ref-audio"), payload, self.timeout)
        return self.request_json_fn("POST", self._url(api_base, "api/v1/base/upload-ref-audio"), payload, self.timeout)

    def transcribe_reference_audio(self, api_base: str, audio_base64: str, *, filename: str | None = None) -> str:
        payload: dict[str, Any] = {"ref_audio_base64": audio_base64}
        if filename:
            payload["ref_audio_filename"] = filename
        response = self.request_json_fn(
            "POST",
            self._url(api_base, "api/v1/base/transcribe"),
            payload,
            self.timeout,
        )
        return str(response.get("text", "")).strip()

    def create_prompt(
        self,
        *,
        api_base: str,
        audio_path: Path,
        ref_text: str,
        name: str,
        x_vector_only_mode: bool = False,
    ) -> dict[str, Any]:
        if self._supports_json_upload(api_base):
            encoded_audio = base64.b64encode(Path(audio_path).expanduser().resolve().read_bytes()).decode("ascii")
            return self.request_json_fn(
                "POST",
                self._url(api_base, "api/v1/base/create-prompt"),
                {
                    "ref_audio_base64": encoded_audio,
                    "ref_audio_filename": Path(audio_path).expanduser().resolve().name,
                    "ref_text": ref_text,
                    "name": name,
                    "x_vector_only_mode": x_vector_only_mode,
                },
                self.timeout,
            )
        uploaded = self.upload_reference_audio(api_base, audio_path)
        return self.request_json_fn(
            "POST",
            self._url(api_base, "api/v1/base/create-prompt"),
            {
                "ref_audio_base64": str(uploaded["audio_base64"]),
                "ref_audio_filename": Path(audio_path).expanduser().resolve().name,
                "ref_text": ref_text,
                "name": name,
                "x_vector_only_mode": x_vector_only_mode,
            },
            self.timeout,
        )

    def delete_prompt(self, api_base: str, prompt_id: str) -> dict[str, Any]:
        return self.request_json_fn(
            "DELETE",
            self._url(api_base, f"api/v1/base/prompts/{prompt_id}"),
            None,
            self.timeout,
        )

    def preview_clone(
        self,
        *,
        api_base: str,
        audio_base64: str,
        audio_filename: str | None = None,
        ref_text: str,
        text: str,
        speed: float,
        output_path: Path,
        language: str = "Auto",
        x_vector_only_mode: bool = False,
    ) -> Path:
        payload: dict[str, Any] = {
            "text": text,
            "language": language,
            "ref_audio_base64": audio_base64,
            "ref_text": ref_text,
            "x_vector_only_mode": x_vector_only_mode,
            "speed": speed,
            "response_format": "base64",
        }
        if audio_filename:
            payload["ref_audio_filename"] = audio_filename
        response = self.request_json_fn(
            "POST",
            self._url(api_base, "api/v1/base/clone"),
            payload,
            self.timeout,
        )
        destination = Path(output_path).expanduser().resolve()
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(decode_audio_payload(response))
        return destination

    def _default_request(self, method: str, url: str, payload: dict[str, Any] | None, timeout: int) -> dict[str, Any]:
        if url.endswith("/upload-ref-audio"):
            if payload is None:
                raise RuntimeError("Upload payload is required.")
            if self._supports_json_upload(url):
                return request_json(method, url, payload, timeout)
            return self._multipart_upload(url, payload, timeout)
        return request_json(method, url, payload, timeout)

    def _multipart_upload(self, url: str, payload: dict[str, Any], timeout: int) -> dict[str, Any]:
        boundary = "----BatchAudioStudioBoundary"
        filename = str(payload["filename"])
        content_type = str(payload.get("content_type") or "application/octet-stream")
        file_bytes = base64.b64decode(str(payload["file_base64"]))
        body = b"".join(
            [
                f"--{boundary}\r\n".encode("utf-8"),
                f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'.encode("utf-8"),
                f"Content-Type: {content_type}\r\n\r\n".encode("utf-8"),
                file_bytes,
                f"\r\n--{boundary}--\r\n".encode("utf-8"),
            ]
        )
        request = urllib.request.Request(
            url,
            data=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}", "Accept": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))

    def _supports_json_upload(self, api_base: str) -> bool:
        normalized = api_base.lower()
        return "modal.run" in normalized or ".modal." in normalized

    def _url(self, api_base: str, path: str) -> str:
        return urllib.parse.urljoin(api_base.rstrip("/") + "/", path)
