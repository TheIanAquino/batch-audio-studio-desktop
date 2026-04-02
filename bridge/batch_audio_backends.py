#!/usr/bin/env python3
from __future__ import annotations

import json

from config import bridge_config_root, load_env, local_api_base, modal_api_base_env

load_env()

LOCAL_BACKEND = "local"
MODAL_BACKEND = "modal"
BACKEND_MODES = (MODAL_BACKEND, LOCAL_BACKEND)
DEFAULT_LOCAL_API_BASE = local_api_base()
CONFIG_ROOT = bridge_config_root()
CONFIG_PATH = CONFIG_ROOT / "config.json"


def _read_config() -> dict:
    if not CONFIG_PATH.exists():
        return {}
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def modal_api_base() -> str:
    env_value = modal_api_base_env()
    if env_value:
        return env_value
    return str(_read_config().get("modal_api_base") or "").strip()


def set_modal_api_base(value: str) -> None:
    CONFIG_ROOT.mkdir(parents=True, exist_ok=True)
    payload = _read_config()
    payload["modal_api_base"] = value.strip()
    CONFIG_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def default_backend_mode() -> str:
    return MODAL_BACKEND if modal_api_base() else LOCAL_BACKEND


def api_base_for_mode(mode: str) -> str:
    normalized = (mode or "").strip().lower()
    if normalized == MODAL_BACKEND:
        return modal_api_base() or DEFAULT_LOCAL_API_BASE or "mock://local"
    return DEFAULT_LOCAL_API_BASE or "mock://local"


def default_api_base() -> str:
    return api_base_for_mode(default_backend_mode())
