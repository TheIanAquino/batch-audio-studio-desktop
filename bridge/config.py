#!/usr/bin/env python3
from __future__ import annotations

import os
from pathlib import Path


def _parse_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not key:
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        values[key] = value
    return values


def _candidate_env_paths() -> list[Path]:
    script_dir = Path(__file__).resolve().parent
    repo_root = script_dir.parent
    cwd = Path.cwd().resolve()
    return [
        repo_root / ".env",
        repo_root / ".env.local",
        cwd / ".env",
        cwd / ".env.local",
    ]


def load_env() -> None:
    for env_path in _candidate_env_paths():
        for key, value in _parse_env_file(env_path).items():
            os.environ.setdefault(key, value)


def env_bool(name: str, default: bool = False) -> bool:
    value = str(os.environ.get(name, "")).strip().lower()
    if not value:
        return default
    return value in {"1", "true", "yes", "on"}


def env_str(name: str, default: str = "") -> str:
    value = str(os.environ.get(name, "")).strip()
    return value if value else default


def app_root() -> Path:
    # The bridge package lives under <repo>/bridge.
    return Path(__file__).resolve().parent.parent


def bridge_config_root() -> Path:
    configured = env_str("BATCH_AUDIO_CONFIG_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    return Path.home() / ".batch-audio-studio"


def bridge_runs_root() -> Path:
    configured = env_str("BATCH_AUDIO_OUTPUT_ROOT")
    if configured:
        return Path(configured).expanduser().resolve()
    return bridge_config_root() / "runs"


def local_api_base() -> str:
    return env_str("BATCH_AUDIO_LOCAL_API_BASE")


def modal_api_base_env() -> str:
    return env_str("BATCH_AUDIO_MODAL_API_BASE")


def local_voice_store() -> Path | None:
    configured = env_str("BATCH_AUDIO_LOCAL_VOICE_STORE")
    if configured:
        return Path(configured).expanduser().resolve()
    return None

