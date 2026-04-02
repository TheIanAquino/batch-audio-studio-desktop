#!/usr/bin/env python3
from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

from config import bridge_config_root, load_env

load_env()

REGISTRY_ROOT = bridge_config_root()
VOICE_ROOT = REGISTRY_ROOT / "voices"
REGISTRY_PATH = REGISTRY_ROOT / "voice_registry.json"


class VoiceRegistry:
    def __init__(self, root: Path = REGISTRY_ROOT) -> None:
        self.root = Path(root)
        self.voice_root = self.root / "voices"
        self.registry_path = self.root / "voice_registry.json"
        self.voice_root.mkdir(parents=True, exist_ok=True)

    def list_names(self) -> list[str]:
        voices = self._read().get("voices", [])
        return sorted([str(voice.get("name") or "") for voice in voices if voice.get("name")], key=str.lower)

    def list_entries(self) -> list[dict[str, Any]]:
        voices = self._read().get("voices", [])
        return sorted(voices, key=lambda voice: str(voice.get("name") or "").lower())

    def get(self, name: str) -> dict[str, Any] | None:
        normalized = name.strip().lower()
        for voice in self._read().get("voices", []):
            if str(voice.get("name") or "").strip().lower() == normalized:
                return voice
        return None

    def save(self, *, name: str, audio_path: Path, ref_text: str, x_vector_only_mode: bool) -> dict[str, Any]:
        source = Path(audio_path).expanduser().resolve()
        slug = self._slugify(name)
        destination = self.voice_root / f"{slug}{source.suffix.lower() or '.wav'}"
        shutil.copy2(source, destination)
        payload = self._read()
        voices = [voice for voice in payload.get("voices", []) if str(voice.get("name") or "").strip().lower() != name.strip().lower()]
        entry = {
            "name": name,
            "audio_path": str(destination),
            "ref_text": ref_text,
            "x_vector_only_mode": bool(x_vector_only_mode),
        }
        voices.append(entry)
        payload["voices"] = sorted(voices, key=lambda voice: str(voice.get("name") or "").lower())
        self._write(payload)
        return entry

    def delete(self, name: str) -> bool:
        payload = self._read()
        normalized = name.strip().lower()
        deleted = False
        voices: list[dict[str, Any]] = []
        for voice in payload.get("voices", []):
            if str(voice.get("name") or "").strip().lower() == normalized:
                deleted = True
                audio_path = Path(str(voice.get("audio_path") or ""))
                if audio_path.exists():
                    audio_path.unlink()
                continue
            voices.append(voice)
        payload["voices"] = voices
        self._write(payload)
        return deleted

    def _read(self) -> dict[str, Any]:
        if not self.registry_path.exists():
            return {"voices": []}
        return json.loads(self.registry_path.read_text(encoding="utf-8"))

    def _write(self, payload: dict[str, Any]) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        self.registry_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    def _slugify(self, value: str) -> str:
        lowered = value.strip().lower()
        pieces = [character if character.isalnum() else "-" for character in lowered]
        compact = "".join(pieces).strip("-")
        while "--" in compact:
            compact = compact.replace("--", "-")
        return compact or "voice"
