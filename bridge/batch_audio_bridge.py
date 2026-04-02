#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import math
import os
import shutil
import threading
import time
import uuid
import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.responses import FileResponse
import uvicorn

from audio_pipeline import assemble_mix, export_mix
from batch_audio_backends import DEFAULT_LOCAL_API_BASE, modal_api_base
from batch_audio_core import DEFAULT_OUTPUT_ROOT, chunk_text, fetch_saved_prompts
from batch_audio_voice_registry import VoiceRegistry
from config import bridge_config_root, env_bool, local_voice_store, load_env
from generation_controller import GenerationController
from studio_repository import StudioRepository
from studio_session import CandidateRecord, StudioSession
from voice_clone_api import VoiceCloneClient

load_env()


@dataclass
class JobState:
    job_id: str
    run_id: str
    prompt_name: str
    voice_id: str
    voice_display_name: str
    run_label: str
    api_base: str
    backend: str
    status: str = "queued"
    created_at: str = field(default_factory=lambda: dt.datetime.now(dt.timezone.utc).isoformat())
    updated_at: str = field(default_factory=lambda: dt.datetime.now(dt.timezone.utc).isoformat())
    session: StudioSession = field(default_factory=StudioSession)
    current_run_dir: Path | None = None
    source_text: str = ""
    progress_percent: float = 0.0
    current_task: str = "Queued"
    events: list[dict[str, Any]] = field(default_factory=list)
    error_message: str | None = None
    preview_mix_path: Path | None = None
    total_generation_time: float | None = None
    run_defaults: dict[str, Any] = field(default_factory=dict)
    cancel_requested: bool = False
    regeneration_requests: set[str] = field(default_factory=set)
    timeline_render_status: str = "idle"
    timeline_render_error: str | None = None
    timeline_render_errors: list[dict[str, Any]] = field(default_factory=list)
    timeline_request_id: str | None = None
    timeline_preview_mix_url: str | None = None
    timeline_export_path: str | None = None
    total_work_units: int = 0
    completed_work_units: int = 0
    _completed_unit_ids: set[str] = field(default_factory=set)
    _lock: threading.RLock = field(default_factory=threading.RLock, init=False, repr=False, compare=False)


class TimelineValidationError(Exception):
    def __init__(self, detail: str, *, code: str = "invalid_timeline", errors: list[dict[str, Any]] | None = None, status_code: int = 400) -> None:
        self.detail = detail
        self.code = code
        self.errors = errors or []
        self.status_code = status_code


class TimelineMissingError(Exception):
    def __init__(self, detail: str) -> None:
        self.detail = detail


controller = GenerationController()
voice_clone_client = VoiceCloneClient()
voice_registry = VoiceRegistry()
jobs: dict[str, JobState] = {}
jobs_lock = threading.Lock()
persist_lock = threading.RLock()
LOCAL_VOICE_STORE = local_voice_store()
MOCK_LOCAL_API_BASE = "mock://local"
MOCK_LOCAL_PROMPT_NAME = "Mock Voice"
MOCK_LOCAL_PROMPT_ID = "mock:voice"
ENABLE_MOCK_TTS = env_bool("BATCH_AUDIO_ENABLE_MOCK_TTS", default=True)
BRIDGE_CONFIG_ROOT = bridge_config_root()
repository = StudioRepository(BRIDGE_CONFIG_ROOT / "studio.db")
PROMPT_DISK_CACHE_PATH = BRIDGE_CONFIG_ROOT / "modal_prompt_cache.json"
PROMPT_CACHE_TTL_SECONDS = 60.0
PROMPT_FETCH_TIMEOUT_SECONDS = 8
PROMPT_ENSURE_TIMEOUT_SECONDS = 30
prompt_cache: dict[str, tuple[float, list[dict[str, Any]], bool]] = {}
VOICE_STATE_CACHE_TTL_SECONDS = 30.0
voice_state_cache: tuple[float, dict[str, Any]] | None = None
media_paths_by_id: dict[str, Path] = {}
media_ids_by_path: dict[str, str] = {}
trusted_external_media_ids: set[str] = set()
media_lock = threading.Lock()
ALLOWED_BRIDGE_ORIGINS = ["http://127.0.0.1:5173", "http://localhost:5173", "null"]
ALLOWED_AUDIO_EXTENSIONS = {".wav", ".mp3", ".m4a", ".aac", ".flac"}


def _timestamp() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def _is_mock_api_base(api_base: str) -> bool:
    return str(api_base or "").strip().lower().startswith("mock://")


def _local_api_base() -> str:
    if DEFAULT_LOCAL_API_BASE:
        return DEFAULT_LOCAL_API_BASE
    if ENABLE_MOCK_TTS:
        return MOCK_LOCAL_API_BASE
    return ""


def _set_job(job: JobState) -> None:
    with job._lock:
        job.source_text = job.session.source_text or job.source_text
        if not str(job.run_label or "").strip() and job.source_text:
            job.run_label = _run_label(job.source_text)
        job.updated_at = _timestamp()
    with jobs_lock:
        jobs[job.job_id] = job
    _persist_job(job)


def _get_job(job_id: str) -> JobState:
    with jobs_lock:
        if job_id in jobs:
            return jobs[job_id]
    persisted = _load_persisted_job(job_id)
    if persisted is None:
        raise KeyError(job_id)
    with jobs_lock:
        jobs[job_id] = persisted
    return persisted


def _safe_prompts(api_base: str, *, allow_network: bool = True, force_refresh: bool = False, timeout: int = PROMPT_FETCH_TIMEOUT_SECONDS) -> list[dict[str, Any]]:
    if not api_base:
        return []
    now = time.time()
    cached = None if force_refresh else prompt_cache.get(api_base)
    if cached and not force_refresh:
        if (now - cached[0]) < PROMPT_CACHE_TTL_SECONDS:
            return cached[1]
    disk_cached = None if force_refresh else _load_prompt_cache_from_disk(api_base)
    if disk_cached is not None:
        prompt_cache[api_base] = (disk_cached["cached_at"], disk_cached["prompts"], disk_cached["available"])
        return disk_cached["prompts"]
    if not allow_network:
        return []
    try:
        prompts = fetch_saved_prompts(api_base, timeout=timeout)
        _store_prompt_cache(api_base, prompts, True)
        prompt_cache[api_base] = (now, prompts, True)
        return prompts
    except Exception:
        if cached:
            return cached[1]
        if disk_cached is not None:
            return disk_cached["prompts"]
        _store_prompt_cache(api_base, [], False)
        prompt_cache[api_base] = (now, [], False)
        return []


def _backend_available(api_base: str, *, allow_network: bool = True, force_refresh: bool = False, timeout: int = PROMPT_FETCH_TIMEOUT_SECONDS) -> bool:
    if not api_base:
        return False
    now = time.time()
    cached = None if force_refresh else prompt_cache.get(api_base)
    if cached and not force_refresh:
        if (now - cached[0]) < PROMPT_CACHE_TTL_SECONDS:
            return cached[2]
    disk_cached = None if force_refresh else _load_prompt_cache_from_disk(api_base)
    if disk_cached is not None:
        prompt_cache[api_base] = (disk_cached["cached_at"], disk_cached["prompts"], disk_cached["available"])
        return disk_cached["available"]
    if not allow_network:
        return False
    try:
        prompts = fetch_saved_prompts(api_base, timeout=timeout)
        _store_prompt_cache(api_base, prompts, True)
        prompt_cache[api_base] = (now, prompts, True)
        return True
    except Exception:
        _store_prompt_cache(api_base, [], False)
        prompt_cache[api_base] = (now, [], False)
        return False


def _invalidate_voice_state_cache() -> None:
    global voice_state_cache
    voice_state_cache = None


def _invalidate_prompt_cache(api_base: str | None = None) -> None:
    if api_base:
        prompt_cache.pop(api_base, None)
        return
    prompt_cache.clear()


def _read_prompt_disk_cache() -> dict[str, Any]:
    if not PROMPT_DISK_CACHE_PATH.exists():
        return {}
    try:
        return json.loads(PROMPT_DISK_CACHE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _load_prompt_cache_from_disk(api_base: str) -> dict[str, Any] | None:
    payload = _read_prompt_disk_cache()
    entry = payload.get(api_base)
    if not isinstance(entry, dict):
        return None
    prompts = entry.get("prompts")
    available = bool(entry.get("available"))
    if not isinstance(prompts, list):
        return None
    cached_at = float(entry.get("cached_at") or 0.0)
    if cached_at <= 0 or (time.time() - cached_at) >= PROMPT_CACHE_TTL_SECONDS:
        return None
    return {"prompts": prompts, "available": available, "cached_at": cached_at}


def _store_prompt_cache(api_base: str, prompts: list[dict[str, Any]], available: bool) -> None:
    BRIDGE_CONFIG_ROOT.mkdir(parents=True, exist_ok=True)
    payload = _read_prompt_disk_cache()
    payload[api_base] = {"prompts": prompts, "available": available, "cached_at": time.time()}
    PROMPT_DISK_CACHE_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _resolve_path(value: str | Path) -> Path:
    return Path(value).expanduser().resolve()


def _register_media_path(value: str | Path, *, trusted_external: bool = False) -> str:
    resolved = _resolve_path(value)
    key = str(resolved)
    with media_lock:
        existing = media_ids_by_path.get(key)
        if existing:
            media_paths_by_id[existing] = resolved
            if trusted_external:
                trusted_external_media_ids.add(existing)
            return existing
        media_id = uuid.uuid4().hex
        media_ids_by_path[key] = media_id
        media_paths_by_id[media_id] = resolved
        if trusted_external:
            trusted_external_media_ids.add(media_id)
        return media_id


def _media_url_for_path(value: str | Path | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, str) and value.startswith("/api/media"):
        return value
    try:
        media_id = _register_media_path(value)
    except Exception:  # noqa: BLE001
        return None
    query = f"id={media_id}"
    bridge_token = str(os.environ.get("BATCH_AUDIO_BRIDGE_TOKEN") or "").strip()
    if bridge_token:
        query = f"{query}&token={bridge_token}"
    return f"/api/media?{query}"


def _validate_user_audio_input_path(value: str | Path) -> Path:
    path = _resolve_path(value)
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=400, detail=f"Audio file does not exist: {path}")
    if path.suffix.lower() not in ALLOWED_AUDIO_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported audio file type: {path.suffix or '<none>'}")
    return path


def _validate_user_export_path(value: str | Path) -> Path:
    path = _resolve_path(value)
    if path.suffix.lower() != ".wav":
        raise HTTPException(status_code=400, detail="destination_path must be an absolute .wav path")
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _is_allowed_media_path(value: str | Path) -> bool:
    target = _resolve_path(value)
    allowed_roots: list[Path] = [DEFAULT_OUTPUT_ROOT.resolve(), BRIDGE_CONFIG_ROOT.resolve()]
    if LOCAL_VOICE_STORE is not None:
        allowed_roots.append(LOCAL_VOICE_STORE.resolve())
    with jobs_lock:
        active_jobs = list(jobs.values())
    for job in active_jobs:
        with job._lock:
            if job.current_run_dir is not None:
                allowed_roots.append(_resolve_path(job.current_run_dir))
    for root in allowed_roots:
        try:
            target.relative_to(root)
            return True
        except ValueError:
            continue
    return False


def _local_saved_voice_audio(prompt_id: str | None) -> str | None:
    if not prompt_id or LOCAL_VOICE_STORE is None:
        return None
    candidate = LOCAL_VOICE_STORE / prompt_id / "audio.wav"
    return str(candidate) if candidate.exists() else None


def _candidate_duration_ms(candidate: CandidateRecord) -> int | None:
    if candidate.duration_ms is not None and candidate.duration_ms > 0:
        return candidate.duration_ms
    try:
        with wave.open(str(candidate.normalized_wav_path), "rb") as handle:
            frame_rate = handle.getframerate()
            if frame_rate <= 0:
                return None
            candidate.duration_ms = round(handle.getnframes() / frame_rate * 1000)
            return candidate.duration_ms
    except Exception:  # noqa: BLE001
        return None


def _serialize_candidate(candidate: CandidateRecord) -> dict[str, Any]:
    duration_ms = _candidate_duration_ms(candidate)
    return {
        "candidate_id": candidate.candidate_id,
        "chunk_id": candidate.chunk_id,
        "source_batch_id": candidate.source_batch_id,
        "variant_label": candidate.variant_label,
        "raw_path": str(candidate.raw_path),
        "normalized_wav_path": str(candidate.normalized_wav_path),
        "status": candidate.status,
        "audio_url": _media_url_for_path(candidate.normalized_wav_path),
        "generation_time": candidate.generation_time,
        "duration_ms": duration_ms,
        "source_prompt_name": candidate.source_prompt_name,
        "source_backend": candidate.source_backend,
        "source_api_base": candidate.source_api_base,
        "created_at": candidate.created_at,
    }


def _serialize_session(job: JobState) -> dict[str, Any]:
    with job._lock:
        return {
            "job_id": job.job_id,
            "run_id": job.run_id,
            "voice_id": job.voice_id,
            "voice_display_name": job.voice_display_name,
            "run_label": job.run_label,
            "status": job.status,
            "backend": job.backend,
            "api_base": job.api_base,
            "prompt_name": job.prompt_name,
            "created_at": job.created_at,
            "updated_at": job.updated_at,
            "current_task": job.current_task,
            "progress_percent": job.progress_percent,
            "error_message": job.error_message,
            "preview_mix_url": _media_url_for_path(job.preview_mix_path),
            "source_text": job.source_text,
            "run_defaults": dict(job.run_defaults),
            "total_generation_time": job.total_generation_time,
            "timeline_render_status": job.timeline_render_status,
            "timeline_render_error": job.timeline_render_error,
            "timeline_render_errors": list(job.timeline_render_errors),
            "timeline_request_id": job.timeline_request_id,
            "timeline_preview_mix_url": _media_url_for_path(job.timeline_preview_mix_url),
            "timeline_export_path": job.timeline_export_path,
            "total_work_units": job.total_work_units,
            "completed_work_units": job.completed_work_units,
            "chunks": [
                {
                    "chunk_id": chunk.chunk_id,
                    "index": chunk.index,
                    "text": chunk.text,
                    "status": chunk.status,
                    "current_task": chunk.current_task,
                    "generation_time": chunk.generation_time,
                    "error_message": chunk.error_message,
                    "selected_candidate_id": job.session.selections.get(chunk.chunk_id),
                    "candidates": [_serialize_candidate(candidate) for candidate in chunk.candidates],
                }
                for chunk in job.session.chunks
            ],
            "events": job.events[-60:],
        }


def _hydrate_job_state(record: dict[str, Any]) -> JobState:
    session = StudioSession.from_persisted(source_text=str(record.get("source_text") or ""), chunks=list(record.get("chunks") or []))
    return JobState(
        job_id=str(record["job_id"]),
        run_id=str(record.get("run_id") or record["job_id"]),
        prompt_name=str(record["prompt_name"]),
        voice_id=str(record.get("voice_id") or record["prompt_name"]),
        voice_display_name=str(record.get("voice_display_name") or record["prompt_name"]),
        run_label=str(record.get("run_label") or record.get("source_text") or record["prompt_name"]),
        api_base=str(record["api_base"]),
        backend=str(record["backend"]),
        status=str(record.get("status") or "queued"),
        created_at=str(record.get("created_at") or _timestamp()),
        updated_at=str(record.get("updated_at") or _timestamp()),
        session=session,
        current_run_dir=Path(str(record["run_dir"])) if record.get("run_dir") else None,
        source_text=str(record.get("source_text") or ""),
        progress_percent=float(record.get("progress_percent") or 0.0),
        current_task=str(record.get("current_task") or "Queued"),
        error_message=None if record.get("error_message") is None else str(record["error_message"]),
        preview_mix_path=Path(str(record["preview_mix_path"])) if record.get("preview_mix_path") else None,
        total_generation_time=None if record.get("total_generation_time") is None else float(record["total_generation_time"]),
        run_defaults={
            "api_base": str(record["api_base"]),
            "backend": str(record["backend"]),
            "variant_count": record.get("variant_count"),
            "chunk_mode": record.get("chunk_mode"),
            "max_chars": record.get("max_chars"),
            "speed": record.get("speed"),
            "pause_ms": record.get("pause_ms"),
            "pause_min_ms": record.get("pause_min_ms"),
            "pause_max_ms": record.get("pause_max_ms"),
            "language": record.get("language"),
        },
        timeline_render_status=str(record.get("timeline_render_status") or "idle"),
        timeline_render_error=None if record.get("timeline_render_error") is None else str(record["timeline_render_error"]),
        timeline_preview_mix_url=None if record.get("timeline_preview_mix_url") is None else str(record["timeline_preview_mix_url"]),
        timeline_export_path=None if record.get("timeline_export_path") is None else str(record["timeline_export_path"]),
        total_work_units=int(record.get("total_work_units") or 0),
        completed_work_units=int(record.get("completed_work_units") or 0),
    )


def _load_persisted_job(job_id: str) -> JobState | None:
    record = repository.load_run(job_id)
    if record is None:
        return None
    return _hydrate_job_state(record)


def _persist_job(job: JobState) -> None:
    if job.current_run_dir is None:
        return
    with persist_lock:
        with job._lock:
            snapshot = {
                "job_id": job.job_id,
                "run_id": job.run_id,
                "voice_id": job.voice_id,
                "voice_display_name": job.voice_display_name,
                "prompt_name": job.prompt_name,
                "backend": job.backend,
                "api_base": job.api_base,
                "source_text": job.source_text,
                "run_label": job.run_label,
                "status": job.status,
                "current_task": job.current_task,
                "progress_percent": job.progress_percent,
                "error_message": job.error_message,
                "created_at": job.created_at,
                "updated_at": job.updated_at,
                "run_dir": str(job.current_run_dir),
                "total_generation_time": job.total_generation_time,
                "preview_mix_path": None if job.preview_mix_path is None else str(job.preview_mix_path),
                "timeline_render_status": job.timeline_render_status,
                "timeline_render_error": job.timeline_render_error,
                "timeline_preview_mix_url": None if job.timeline_preview_mix_url is None else str(job.timeline_preview_mix_url),
                "timeline_export_path": job.timeline_export_path,
                "variant_count": job.run_defaults.get("variant_count"),
                "chunk_mode": job.run_defaults.get("chunk_mode"),
                "max_chars": job.run_defaults.get("max_chars"),
                "speed": job.run_defaults.get("speed"),
                "pause_ms": job.run_defaults.get("pause_ms"),
                "pause_min_ms": job.run_defaults.get("pause_min_ms"),
                "pause_max_ms": job.run_defaults.get("pause_max_ms"),
                "language": job.run_defaults.get("language"),
            }
            chunk_snapshots = [
                {
                    "chunk_id": chunk.chunk_id,
                    "chunk_index": chunk.index,
                    "text": chunk.text,
                    "status": chunk.status,
                    "current_task": chunk.current_task,
                    "generation_time": chunk.generation_time,
                    "error_message": chunk.error_message,
                }
                for chunk in job.session.chunks
            ]
            candidate_snapshots = [
                {
                    "candidate_id": candidate.candidate_id,
                    "chunk_id": candidate.chunk_id,
                    "source_batch_id": candidate.source_batch_id,
                    "variant_label": candidate.variant_label,
                    "status": candidate.status,
                    "raw_path": str(candidate.raw_path),
                    "normalized_wav_path": str(candidate.normalized_wav_path),
                    "duration_ms": candidate.duration_ms,
                    "generation_time": candidate.generation_time,
                    "source_prompt_name": candidate.source_prompt_name,
                    "source_backend": candidate.source_backend,
                    "source_api_base": candidate.source_api_base,
                    "created_at": candidate.created_at,
                }
                for chunk in job.session.chunks
                for candidate in chunk.candidates
            ]
            selection_snapshots = dict(job.session.selections)
            valid_candidates_by_chunk = {
                chunk.chunk_id: {candidate.candidate_id for candidate in chunk.candidates}
                for chunk in job.session.chunks
            }
        repository.upsert_run(snapshot)
        repository.replace_chunks(snapshot["run_id"], chunk_snapshots)
        repository.add_candidates(snapshot["run_id"], candidate_snapshots)
        for chunk_id, candidate_id in selection_snapshots.items():
            if candidate_id not in valid_candidates_by_chunk.get(chunk_id, set()):
                continue
            repository.set_chunk_selection(chunk_id, candidate_id)


def _state_jobs_payload() -> list[dict[str, Any]]:
    persisted_jobs = {str(record["job_id"]): _serialize_persisted_run(record) for record in repository.load_runs(limit=200)}
    with jobs_lock:
        active_jobs = {job_id: _serialize_session(job) for job_id, job in jobs.items()}
    combined = {**persisted_jobs, **active_jobs}
    return sorted(combined.values(), key=lambda item: str(item.get("created_at") or ""), reverse=True)


def _serialize_persisted_run(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "job_id": str(record["job_id"]),
        "run_id": str(record.get("run_id") or record["job_id"]),
        "voice_id": str(record.get("voice_id") or record["prompt_name"]),
        "voice_display_name": str(record.get("voice_display_name") or record["prompt_name"]),
        "run_label": str(record.get("run_label") or record.get("source_text") or record["prompt_name"]),
        "status": str(record.get("status") or "queued"),
        "backend": str(record["backend"]),
        "api_base": str(record["api_base"]),
        "prompt_name": str(record["prompt_name"]),
        "created_at": str(record.get("created_at") or ""),
        "updated_at": str(record.get("updated_at") or ""),
        "current_task": str(record.get("current_task") or "Queued"),
        "progress_percent": float(record.get("progress_percent") or 0.0),
        "error_message": None if record.get("error_message") is None else str(record["error_message"]),
        "preview_mix_url": _media_url_for_path(record.get("preview_mix_path")),
        "source_text": str(record.get("source_text") or ""),
        "run_defaults": {
            "api_base": str(record["api_base"]),
            "backend": str(record["backend"]),
            "variant_count": record.get("variant_count"),
            "chunk_mode": record.get("chunk_mode"),
            "max_chars": record.get("max_chars"),
            "speed": record.get("speed"),
            "pause_ms": record.get("pause_ms"),
            "pause_min_ms": record.get("pause_min_ms"),
            "pause_max_ms": record.get("pause_max_ms"),
            "language": record.get("language"),
        },
        "total_generation_time": None if record.get("total_generation_time") is None else float(record["total_generation_time"]),
        "timeline_render_status": str(record.get("timeline_render_status") or "idle"),
        "timeline_render_error": None if record.get("timeline_render_error") is None else str(record["timeline_render_error"]),
        "timeline_render_errors": [],
        "timeline_request_id": None,
        "timeline_preview_mix_url": _media_url_for_path(record.get("timeline_preview_mix_url")),
        "timeline_export_path": None if record.get("timeline_export_path") is None else str(record["timeline_export_path"]),
        "total_work_units": int(record.get("total_work_units") or 0),
        "completed_work_units": int(record.get("completed_work_units") or 0),
        "chunks": [
            {
                "chunk_id": str(chunk["chunk_id"]),
                "index": int(chunk["chunk_index"]),
                "text": str(chunk["text"]),
                "status": str(chunk.get("status") or "queued"),
                "current_task": str(chunk.get("current_task") or "Queued"),
                "generation_time": None if chunk.get("generation_time") is None else float(chunk["generation_time"]),
                "error_message": None if chunk.get("error_message") is None else str(chunk["error_message"]),
                "selected_candidate_id": chunk.get("selected_candidate_id"),
                "candidates": [
                    {
                        "candidate_id": str(candidate["candidate_id"]),
                        "chunk_id": str(candidate["chunk_id"]),
                        "source_batch_id": str(candidate["source_batch_id"]),
                        "variant_label": str(candidate["variant_label"]),
                        "raw_path": str(candidate["raw_path"]),
                        "normalized_wav_path": str(candidate["normalized_wav_path"]),
                        "status": str(candidate["status"]),
                        "audio_url": _media_url_for_path(candidate["normalized_wav_path"]),
                        "generation_time": None if candidate.get("generation_time") is None else float(candidate["generation_time"]),
                        "duration_ms": None if candidate.get("duration_ms") is None else int(candidate["duration_ms"]),
                        "source_prompt_name": candidate.get("source_prompt_name"),
                        "source_backend": candidate.get("source_backend"),
                        "source_api_base": candidate.get("source_api_base"),
                        "created_at": candidate.get("created_at"),
                    }
                    for candidate in list(chunk.get("candidates") or [])
                ],
            }
            for chunk in list(record.get("chunks") or [])
        ],
        "events": [],
    }


def _ensure_prompt_available(api_base: str, prompt_name: str) -> dict[str, Any]:
    if _is_mock_api_base(api_base):
        return {"name": prompt_name or MOCK_LOCAL_PROMPT_NAME, "prompt_id": MOCK_LOCAL_PROMPT_ID}
    prompts = _safe_prompts(api_base, timeout=PROMPT_ENSURE_TIMEOUT_SECONDS)
    for prompt in prompts:
        if prompt.get("name") == prompt_name:
            return prompt
    voice = voice_registry.get(prompt_name)
    if voice is None:
        raise RuntimeError(f"Voice '{prompt_name}' is not available on this backend and has not been imported as a portable voice yet.")
    response = voice_clone_client.create_prompt(
        api_base=api_base,
        audio_path=Path(str(voice["audio_path"])),
        ref_text=str(voice.get("ref_text") or ""),
        name=prompt_name,
        x_vector_only_mode=bool(voice.get("x_vector_only_mode")),
    )
    return {"name": prompt_name, "prompt_id": response.get("prompt_id")}


def _build_voice_inventory(
    *,
    local_allow_network: bool = True,
    modal_allow_network: bool = True,
    force_refresh: bool = False,
) -> list[dict[str, Any]]:
    local_base = _local_api_base()
    local_prompts = _safe_prompts(local_base, allow_network=local_allow_network, force_refresh=force_refresh) if local_base and not _is_mock_api_base(local_base) else []
    modal_base = modal_api_base()
    modal_prompts = _safe_prompts(modal_base, allow_network=modal_allow_network, force_refresh=force_refresh) if modal_base else []
    portable_entries = voice_registry.list_entries()
    names = {
        *[str(item.get("name") or "") for item in local_prompts if item.get("name")],
        *[str(item.get("name") or "") for item in modal_prompts if item.get("name")],
        *[str(item.get("name") or "") for item in portable_entries if item.get("name")],
    }
    if ENABLE_MOCK_TTS:
        names.add(MOCK_LOCAL_PROMPT_NAME)
    inventory: list[dict[str, Any]] = []
    portable_lookup = {str(item.get("name") or ""): item for item in portable_entries}
    for name in sorted([item for item in names if item], key=str.lower):
        local_prompt = next((item for item in local_prompts if item.get("name") == name), None)
        if local_prompt is None and ENABLE_MOCK_TTS and name == MOCK_LOCAL_PROMPT_NAME:
            local_prompt = {"name": MOCK_LOCAL_PROMPT_NAME, "prompt_id": MOCK_LOCAL_PROMPT_ID}
        modal_prompt = next((item for item in modal_prompts if item.get("name") == name), None)
        registry_entry = portable_lookup.get(name)
        modal_prompt_id = None if modal_prompt is None else str(modal_prompt.get("prompt_id") or "")
        is_builtin_only_modal_voice = (
            modal_prompt is not None
            and modal_prompt_id.startswith("builtin:")
            and local_prompt is None
            and registry_entry is None
        )
        if is_builtin_only_modal_voice:
            continue
        sources: list[str] = []
        if local_prompt:
            sources.append("local")
        if modal_prompt:
            sources.append("modal")
        if registry_entry:
            sources.append("portable")
        inventory.append(
            {
                "name": name,
                "available_local": local_prompt is not None,
                "available_modal": modal_prompt is not None,
                "portable": registry_entry is not None,
                "sources": sources,
                "local_prompt_id": None if local_prompt is None else local_prompt.get("prompt_id"),
                "local_ref_text": None if local_prompt is None else local_prompt.get("ref_text"),
                "local_audio_path": None if local_prompt is None else _local_saved_voice_audio(str(local_prompt.get("prompt_id") or "")),
                "modal_prompt_id": None if modal_prompt is None else modal_prompt.get("prompt_id"),
                "registry_entry": None
                if registry_entry is None
                else {
                    "audio_path": str(registry_entry.get("audio_path") or ""),
                    "ref_text": str(registry_entry.get("ref_text") or ""),
                    "x_vector_only_mode": bool(registry_entry.get("x_vector_only_mode")),
                },
            }
        )
    return inventory


def _find_voice_inventory_entry(name: str, *, force_refresh: bool = False) -> dict[str, Any] | None:
    normalized = name.strip().lower()
    for voice in _build_voice_inventory(force_refresh=force_refresh):
        if str(voice.get("name") or "").strip().lower() == normalized:
            return voice
    return None


def _is_builtin_prompt_id(prompt_id: Any) -> bool:
    return str(prompt_id or "").startswith("builtin:")


def _base_state_payload(*, force_refresh: bool = False) -> dict[str, Any]:
    global voice_state_cache
    if not force_refresh and voice_state_cache:
        cached_payload = dict(voice_state_cache[1])
        cached_payload["modal_pool"] = controller.modal_pool_snapshot()
        return cached_payload

    now = time.time()
    local_base = _local_api_base()
    local_available = _is_mock_api_base(local_base) or (bool(local_base) and _backend_available(local_base, allow_network=True, force_refresh=force_refresh))
    modal_base = modal_api_base()
    modal_available = bool(modal_base) and _backend_available(modal_base, allow_network=force_refresh, force_refresh=force_refresh)
    inventory = _build_voice_inventory(
        local_allow_network=True,
        modal_allow_network=force_refresh,
        force_refresh=force_refresh,
    )
    payload = {
        "local_api_base": local_base,
        "modal_api_base": modal_base,
        "local_available": local_available,
        "modal_available": modal_available,
        "modal_pool": controller.modal_pool_snapshot(),
        "voices": inventory,
    }
    voice_state_cache = (now, payload)
    return dict(payload)


def _write_mock_wav(path: Path, duration_ms: int, *, sample_rate: int = 16000) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    frames = max(1, int(sample_rate * (duration_ms / 1000.0)))
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(b"\x00\x00" * frames)


def _mock_duration_for_text(text: str) -> int:
    normalized = max(1, len(text.strip()))
    words = max(1, len([token for token in text.split() if token.strip()]))
    rough = int(words * 340 + math.sqrt(normalized) * 120)
    return max(700, min(8000, rough))


def _run_mock_generation(job: JobState, payload: dict[str, Any]) -> None:
    variant_count = max(1, int(payload.get("variant_count") or 1))
    chunk_mode = str(payload.get("chunk_mode") or "sentence")
    max_chars = int(payload.get("max_chars") or 220)
    effective_chunks = chunk_text(job.source_text, chunk_mode, max_chars)
    if not effective_chunks:
        raise RuntimeError("text did not produce any chunks")
    job.session.set_chunks(effective_chunks, source_text=job.source_text)
    total = len(effective_chunks) * variant_count
    completed = 0

    with job._lock:
        job.total_work_units = total
        job.completed_work_units = 0
        job._completed_unit_ids.clear()
        job.status = "running"
        job.current_task = "Generating mock candidates"
    _set_job(job)

    batch_id = f"mock-{uuid.uuid4().hex[:8]}"
    output_root = Path(job.current_run_dir or DEFAULT_OUTPUT_ROOT)
    candidates: list[CandidateRecord] = []
    for variant in range(1, variant_count + 1):
        variant_dir = output_root / f"variant_{variant:02d}"
        for chunk in job.session.chunks:
            duration_ms = _mock_duration_for_text(chunk.text)
            raw_path = variant_dir / f"v{variant}_chunk_{chunk.index:03d}.wav"
            normalized_path = variant_dir / f"v{variant}_chunk_{chunk.index:03d}.normalized.wav"
            _write_mock_wav(raw_path, duration_ms)
            if normalized_path != raw_path:
                shutil.copyfile(raw_path, normalized_path)
            candidates.append(
                CandidateRecord(
                    candidate_id=f"{batch_id}-{chunk.chunk_id}-{variant:02d}",
                    chunk_id=chunk.chunk_id,
                    source_batch_id=batch_id,
                    variant_label=f"V{variant}",
                    raw_path=raw_path,
                    normalized_wav_path=normalized_path,
                    status="generated",
                    generation_time=round(duration_ms / 1000, 2),
                    duration_ms=duration_ms,
                    source_prompt_name=job.prompt_name,
                    source_backend="mock",
                    source_api_base=MOCK_LOCAL_API_BASE,
                    created_at=_timestamp(),
                )
            )
            completed += 1
            with job._lock:
                job.completed_work_units = completed
                job.progress_percent = _progress_percent(completed, total)
                job.current_task = f"Generating mock V{variant}/{variant_count} chunk {chunk.index}/{len(job.session.chunks)}"
                job.session.set_chunk_status(chunk.chunk_id, status="completed", current_task="Ready", generation_time=round(duration_ms / 1000, 2), error_message=None)
            _set_job(job)

    job.session.add_candidates(candidates)
    for chunk in job.session.chunks:
        if chunk.candidates:
            job.session.select_candidate(chunk.chunk_id, chunk.candidates[0].candidate_id)
    with job._lock:
        job.status = "completed"
        job.progress_percent = 100.0
        job.current_task = "Mock generation complete"
    _set_job(job)


def _run_mock_regeneration(
    *,
    job: JobState,
    chunk_id: str,
    variant_count: int,
    prompt_name: str,
    text_override: str | None,
) -> None:
    chunk = job.session.get_chunk(chunk_id)
    if text_override:
        chunk.text = text_override
    output_root = Path(job.current_run_dir or DEFAULT_OUTPUT_ROOT)
    batch_id = f"mock-rerun-{uuid.uuid4().hex[:8]}"
    with job._lock:
        job.total_work_units = max(1, variant_count)
        job.completed_work_units = 0
        job._completed_unit_ids.clear()
        job.status = "running"
        job.current_task = "Regenerating mock chunk"
        job.session.set_chunk_status(chunk_id, status="running", current_task="Regenerating mock chunk", error_message=None)
    _set_job(job)

    generated: list[CandidateRecord] = []
    for variant in range(1, variant_count + 1):
        duration_ms = _mock_duration_for_text(chunk.text)
        variant_dir = output_root / f"chunk_{chunk.index:02d}_rerun_{variant:02d}"
        raw_path = variant_dir / f"chunk_{chunk.index:02d}_rerun_{variant:02d}.wav"
        normalized_path = variant_dir / f"chunk_{chunk.index:02d}_rerun_{variant:02d}.normalized.wav"
        _write_mock_wav(raw_path, duration_ms)
        if normalized_path != raw_path:
            shutil.copyfile(raw_path, normalized_path)
        generated.append(
            CandidateRecord(
                candidate_id=f"{batch_id}-{chunk.chunk_id}-{variant:02d}",
                chunk_id=chunk.chunk_id,
                source_batch_id=batch_id,
                variant_label=f"R{variant}",
                raw_path=raw_path,
                normalized_wav_path=normalized_path,
                status="generated",
                generation_time=round(duration_ms / 1000, 2),
                duration_ms=duration_ms,
                source_prompt_name=prompt_name,
                source_backend="mock",
                source_api_base=MOCK_LOCAL_API_BASE,
                created_at=_timestamp(),
            )
        )
        with job._lock:
            job.completed_work_units = variant
            job.progress_percent = _progress_percent(variant, max(1, variant_count))
            job.current_task = f"Regenerated {variant}/{variant_count} mock candidate sets"
            job.session.set_chunk_status(chunk_id, status="completed", current_task="Ready", generation_time=round(duration_ms / 1000, 2), error_message=None)
        _set_job(job)

    job.session.add_candidates(generated)
    if not job.session.selections.get(chunk_id):
        job.session.select_candidate(chunk_id, generated[0].candidate_id)
    with job._lock:
        job.status = "completed"
        job.current_task = "Chunk regeneration complete"
    _set_job(job)


def _run_generation(job: JobState, payload: dict[str, Any]) -> None:
    chunk_started_at: dict[str, float] = {}
    started_at = time.time()
    try:
        if _is_mock_api_base(job.api_base):
            _run_mock_generation(job, payload)
            with job._lock:
                job.total_generation_time = round(time.time() - started_at, 2)
            _set_job(job)
            return
        render_kwargs: dict[str, Any] = {}
        pause_min_ms, pause_max_ms = _normalize_pause_range(
            pause_min_ms=payload.get("pause_min_ms"),
            pause_max_ms=payload.get("pause_max_ms"),
            pause_ms=payload.get("pause_ms"),
            fallback_min_ms=int(job.run_defaults.get("pause_min_ms") or 250),
            fallback_max_ms=int(job.run_defaults.get("pause_max_ms") or job.run_defaults.get("pause_ms") or 420),
        )
        pause_default_ms = pause_max_ms
        _ensure_prompt_available(job.api_base, job.prompt_name)
        with job._lock:
            job.total_work_units = 0
            job.completed_work_units = 0
            job._completed_unit_ids.clear()
            job.status = "running"
            job.current_task = "Generating batch candidates"
        _set_job(job)

        def progress_callback(event: dict[str, Any]) -> None:
            with job._lock:
                event_copy = {**event, "timestamp": _timestamp()}
                job.events.append(event_copy)
                event_type = str(event.get("type") or "")
                if event_type == "chunk_start":
                    if event.get("mode") == "full_batch":
                        variant = int(event.get("variant") or 1)
                        variant_total = max(1, int(event.get("variant_total") or 1))
                        chunk_index = int(event.get("index") or 1)
                        chunk_total = max(1, int(event.get("total") or 1))
                        job.total_work_units = max(job.total_work_units, variant_total * chunk_total)
                        job.progress_percent = _progress_percent(job.completed_work_units, job.total_work_units)
                        job.current_task = f"Generating V{variant}/{variant_total} chunk {chunk_index}/{chunk_total}"
                        chunk = job.session.chunks[chunk_index - 1] if len(job.session.chunks) >= chunk_index else None
                        if chunk is not None:
                            chunk_started_at[chunk.chunk_id] = time.time()
                            job.session.set_chunk_status(chunk.chunk_id, status="running", current_task=job.current_task, error_message=None)
                    else:
                        rerun_index = int(event.get("regeneration_index") or 1)
                        rerun_total = max(1, int(event.get("regeneration_total") or 1))
                        job.total_work_units = max(job.total_work_units, rerun_total)
                        job.progress_percent = _progress_percent(job.completed_work_units, job.total_work_units)
                        job.current_task = f"Regenerating candidate set {rerun_index}/{rerun_total}"
                        chunk_id = str(event.get("chunk_id") or "")
                        if chunk_id:
                            chunk_started_at[chunk_id] = time.time()
                            job.session.set_chunk_status(chunk_id, status="running", current_task=job.current_task, error_message=None)
                elif event_type == "chunk_done":
                    unit_id = f"full:{event.get('variant') or 1}:{event.get('index') or 1}"
                    if unit_id not in job._completed_unit_ids:
                        job._completed_unit_ids.add(unit_id)
                        job.completed_work_units += 1
                    job.progress_percent = _progress_percent(job.completed_work_units, job.total_work_units)
                    chunk_index = int(event.get("index") or 1)
                    if len(job.session.chunks) >= chunk_index:
                        chunk = job.session.chunks[chunk_index - 1]
                        started = chunk_started_at.get(chunk.chunk_id)
                        generation_time = None if started is None else round(time.time() - started, 2)
                        job.session.set_chunk_status(chunk.chunk_id, status="completed", current_task="Ready", generation_time=generation_time, error_message=None)
                elif event_type == "regeneration_done":
                    unit_id = f"regen:{event.get('chunk_id') or ''}:{event.get('regeneration_index') or 1}"
                    if unit_id not in job._completed_unit_ids:
                        job._completed_unit_ids.add(unit_id)
                        job.completed_work_units += 1
                    job.progress_percent = _progress_percent(job.completed_work_units, job.total_work_units)
            _set_job(job)

        controller.generate_full_batch(
            session=job.session,
            text=job.source_text,
            variant_count=int(payload.get("variant_count") or 3),
            api_base=job.api_base,
            prompt_name=job.prompt_name,
            chunk_mode=str(payload.get("chunk_mode") or "sentence"),
            max_chars=int(payload.get("max_chars") or 220),
            speed=float(payload.get("speed") or 1.0),
            pause_ms=pause_default_ms,
            pause_min_ms=pause_min_ms,
            pause_max_ms=pause_max_ms,
            output_root=Path(job.current_run_dir or DEFAULT_OUTPUT_ROOT),
            language=str(payload.get("language") or "Auto"),
            source_backend=job.backend,
            progress_callback=progress_callback,
            render_kwargs=render_kwargs,
            should_cancel=lambda: job.cancel_requested,
        )
        with job._lock:
            if job.cancel_requested:
                job.status = "canceled"
                job.current_task = "Run canceled"
                _set_job(job)
                return
            for chunk in job.session.chunks:
                if chunk.candidates:
                    job.session.select_candidate(chunk.chunk_id, chunk.candidates[0].candidate_id)
            job.status = "completed"
            job.progress_percent = 100.0
            job.current_task = "Generation complete"
            job.total_generation_time = round(time.time() - started_at, 2)
            _set_job(job)
    except Exception as exc:  # noqa: BLE001
        with job._lock:
            job.status = "failed"
            job.error_message = str(exc)
            job.current_task = "Generation failed"
        _set_job(job)


def _validate_variant_count(value: Any) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="variant_count must be an integer") from exc
    if parsed < 1 or parsed > 12:
        raise HTTPException(status_code=400, detail="variant_count must be between 1 and 12")
    return parsed


def _normalize_pause_range(
    *,
    pause_min_ms: Any = None,
    pause_max_ms: Any = None,
    pause_ms: Any = None,
    fallback_min_ms: int = 250,
    fallback_max_ms: int = 420,
) -> tuple[int, int]:
    def _to_int(value: Any, field: str) -> int:
        try:
            return int(value)
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=f"{field} must be an integer") from exc

    if pause_min_ms is None and pause_max_ms is None and pause_ms is not None:
        parsed = max(0, _to_int(pause_ms, "pause_ms"))
        return parsed, parsed

    minimum = fallback_min_ms if pause_min_ms is None else max(0, _to_int(pause_min_ms, "pause_min_ms"))
    maximum = fallback_max_ms if pause_max_ms is None else max(0, _to_int(pause_max_ms, "pause_max_ms"))
    if minimum > maximum:
        minimum, maximum = maximum, minimum
    return minimum, maximum


def _progress_percent(completed: int, total: int) -> float:
    if total <= 0:
        return 0.0
    return round(min(100.0, (completed / total) * 100), 2)


def _every_chunk_selected(job: JobState) -> bool:
    with job._lock:
        return bool(job.session.chunks) and all(job.session.selections.get(chunk.chunk_id) for chunk in job.session.chunks)


def _run_label(source_text: str) -> str:
    first_line = next((line.strip() for line in source_text.splitlines() if line.strip()), "Untitled prompt")
    return first_line[:72]


def _append_to_job(job: JobState, payload: dict[str, Any]) -> list[str]:
    _ensure_job_editable(job)
    source_text = str(payload.get("text") or "").strip()
    if not source_text:
        raise HTTPException(status_code=400, detail="text is required")

    variant_count = _validate_variant_count(payload.get("variant_count") or job.run_defaults.get("variant_count") or 3)
    chunk_mode = str(payload.get("chunk_mode") or job.run_defaults.get("chunk_mode") or "sentence")
    max_chars = int(payload.get("max_chars") or job.run_defaults.get("max_chars") or 220)
    pause_min_ms, pause_max_ms = _normalize_pause_range(
        pause_min_ms=payload.get("pause_min_ms"),
        pause_max_ms=payload.get("pause_max_ms"),
        pause_ms=payload.get("pause_ms"),
        fallback_min_ms=int(job.run_defaults.get("pause_min_ms") or 250),
        fallback_max_ms=int(job.run_defaults.get("pause_max_ms") or job.run_defaults.get("pause_ms") or 420),
    )
    chunk_texts = chunk_text(source_text, chunk_mode, max_chars)
    if not chunk_texts:
        raise HTTPException(status_code=400, detail="text did not produce any chunks")

    with job._lock:
        after_chunk_id = job.session.chunks[-1].chunk_id if job.session.chunks else None
        inserted_chunks = []
        for text in chunk_texts:
            inserted = job.session.insert_chunk(text, after_chunk_id=after_chunk_id)
            inserted_chunks.append(inserted)
            after_chunk_id = inserted.chunk_id

        job.run_defaults = {
            **job.run_defaults,
            "api_base": str(payload.get("api_base") or job.run_defaults.get("api_base") or job.api_base),
            "backend": str(payload.get("backend") or job.run_defaults.get("backend") or job.backend),
            "variant_count": variant_count,
            "chunk_mode": chunk_mode,
            "max_chars": max_chars,
            "speed": float(payload.get("speed") or job.run_defaults.get("speed") or 1.0),
            "pause_ms": pause_max_ms,
            "pause_min_ms": pause_min_ms,
            "pause_max_ms": pause_max_ms,
            "language": str(payload.get("language") or job.run_defaults.get("language") or "Auto"),
        }
        _reset_timeline_state(job)
    _set_job(job)

    if not bool(payload.get("generate_versions", True)):
        return [chunk.chunk_id for chunk in inserted_chunks]

    for inserted in inserted_chunks:
        _regenerate_chunk(
            job,
            inserted.chunk_id,
            {
                "request_id": f"append-{inserted.chunk_id}-{uuid.uuid4().hex[:8]}",
                "text_override": inserted.text,
                "variant_count": variant_count,
                "prompt_name": str(payload.get("prompt_name") or job.prompt_name),
                "backend": str(payload.get("backend") or job.run_defaults.get("backend") or job.backend),
                "api_base": str(payload.get("api_base") or job.run_defaults.get("api_base") or job.api_base),
                "speed": float(payload.get("speed") or job.run_defaults.get("speed") or 1.0),
                "pause_ms": pause_max_ms,
                "pause_min_ms": pause_min_ms,
                "pause_max_ms": pause_max_ms,
                "max_chars": max_chars,
                "language": str(payload.get("language") or job.run_defaults.get("language") or "Auto"),
            },
        )

    return [chunk.chunk_id for chunk in inserted_chunks]


def _reorder_job_chunk(job: JobState, chunk_id: str, to_index: int) -> None:
    _ensure_job_editable(job)
    with job._lock:
        try:
            job.session.move_chunk(chunk_id, to_index)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"Unknown chunk {chunk_id}") from exc
        _reset_timeline_state(job)
        job.current_task = "Reordered chunks"
    _set_job(job)


def _reset_timeline_state(job: JobState) -> None:
    with job._lock:
        job.timeline_render_status = "idle"
        job.timeline_render_error = None
        job.timeline_render_errors = []
        job.timeline_request_id = None
        job.timeline_preview_mix_url = None
        job.timeline_export_path = None


def _timeline_error_response(exc: TimelineValidationError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail, "code": exc.code, "errors": exc.errors},
    )


def _timeline_selected_snapshot(job: JobState) -> list[dict[str, Any]]:
    snapshot: list[dict[str, Any]] = []
    with job._lock:
        for chunk in job.session.chunks:
            selected_id = job.session.selections.get(chunk.chunk_id)
            if not selected_id:
                continue
            candidate = job.session.selected_candidate(chunk.chunk_id)
            snapshot.append(
                {
                    "chunk_id": chunk.chunk_id,
                    "candidate_id": candidate.candidate_id,
                    "path": Path(candidate.normalized_wav_path),
                    "duration_ms": int(_candidate_duration_ms(candidate) or 0),
                }
            )
    return snapshot


def _validate_timeline_payload(job: JobState, payload: dict[str, Any], *, require_export_path: bool) -> tuple[str, list[dict[str, Any]], Path | None]:
    request_id = str(payload.get("request_id") or "").strip()
    if not request_id:
        raise TimelineValidationError(
            "Timeline validation failed",
            errors=[{"code": "missing_request_id", "message": "request_id is required"}],
        )

    clips = payload.get("clips")
    if not isinstance(clips, list) or not clips:
        raise TimelineValidationError(
            "Timeline validation failed",
            errors=[{"code": "empty_timeline", "message": "clips must be a non-empty array"}],
        )

    selected = _timeline_selected_snapshot(job)
    if len(selected) != len(job.session.chunks):
        raise TimelineValidationError(
            "Timeline validation failed",
            errors=[{"code": "legacy_job_timeline_unsupported", "message": "Selected candidates need duration metadata before timeline rendering is supported"}],
        )
    if any(item["duration_ms"] <= 0 for item in selected):
        raise TimelineValidationError(
            "Timeline validation failed",
            errors=[{"code": "legacy_job_timeline_unsupported", "message": "Selected candidates need duration metadata before timeline rendering is supported"}],
        )

    selected_by_chunk = {item["chunk_id"]: item for item in selected}
    if len(clips) != len(selected_by_chunk):
        raise TimelineValidationError(
            "Timeline validation failed",
            errors=[{"code": "invalid_timeline_clip", "message": "Timeline clips must exactly match the selected chunk set"}],
        )

    validated_clips: list[dict[str, Any]] = []
    seen_chunks: set[str] = set()
    for index, clip in enumerate(clips):
        if not isinstance(clip, dict):
            raise TimelineValidationError(
                "Timeline validation failed",
                errors=[{"code": "invalid_timeline_clip", "message": "Each timeline clip must be an object", "clip_index": index}],
            )
        chunk_id = str(clip.get("chunk_id") or "").strip()
        candidate_id = str(clip.get("candidate_id") or "").strip()
        if chunk_id not in selected_by_chunk:
            raise TimelineMissingError(f"Unknown chunk {chunk_id}")
        selected_item = selected_by_chunk[chunk_id]
        if chunk_id in seen_chunks:
            raise TimelineValidationError(
                "Timeline validation failed",
                errors=[{"code": "invalid_timeline_clip", "message": "Duplicate chunk in timeline payload", "clip_index": index}],
            )
        if candidate_id != selected_item["candidate_id"]:
            raise TimelineValidationError(
                "Timeline validation failed",
                errors=[{"code": "invalid_timeline_clip", "message": "Timeline clip must use the currently selected candidate", "clip_index": index}],
            )
        try:
            trim_in_ms = int(clip.get("trim_in_ms"))
            trim_out_ms = int(clip.get("trim_out_ms"))
            source_duration_ms = int(clip.get("source_duration_ms"))
        except (TypeError, ValueError):
            raise TimelineValidationError(
                "Timeline validation failed",
                errors=[{"code": "invalid_timeline_clip", "message": "Timeline trim and duration values must be integers", "clip_index": index}],
            )
        if trim_in_ms < 0 or trim_out_ms < 0:
            raise TimelineValidationError(
                "Timeline validation failed",
                errors=[{"code": "invalid_timeline_clip", "message": "Trim values must be non-negative", "clip_index": index}],
            )
        if abs(source_duration_ms - selected_item["duration_ms"]) > 10:
            raise TimelineValidationError(
                "Timeline validation failed",
                errors=[{"code": "invalid_timeline_clip", "message": "Timeline duration metadata is stale", "clip_index": index}],
            )
        if trim_in_ms + trim_out_ms >= source_duration_ms:
            raise TimelineValidationError(
                "Timeline validation failed",
                errors=[{"code": "invalid_timeline_clip", "message": "Trim range removes the full clip", "clip_index": index}],
            )
        seen_chunks.add(chunk_id)
        validated_clips.append(
            {
                "chunk_id": chunk_id,
                "candidate_id": candidate_id,
                "path": selected_item["path"],
                "duration_ms": source_duration_ms,
                "trim_in_ms": trim_in_ms,
                "trim_out_ms": trim_out_ms,
            }
        )

    destination: Path | None = None
    if require_export_path:
        raw_path = str(payload.get("export_path") or "").strip()
        if not raw_path:
            raise TimelineValidationError(
                "Timeline validation failed",
                code="invalid_export_path",
                errors=[{"code": "invalid_export_path", "message": "export_path is required"}],
            )
        try:
            destination = _validate_user_export_path(raw_path)
        except HTTPException as exc:
            raise TimelineValidationError(
                "Timeline validation failed",
                code="invalid_export_path",
                errors=[{"code": "invalid_export_path", "message": str(exc.detail)}],
            ) from exc

    return request_id, validated_clips, destination


def _regenerate_chunk(job: JobState, chunk_id: str, payload: dict[str, Any]) -> None:
    chunk_started_at: dict[str, float] = {}
    started_at = time.time()
    request_id = ""
    try:
        request_id = str(payload.get("request_id") or "").strip()
        if not request_id:
            raise HTTPException(status_code=400, detail="request_id is required")
        if request_id in job.regeneration_requests:
            return

        text_override = payload.get("text_override")
        if text_override is not None:
            text_override = str(text_override).strip()
            if not text_override:
                raise HTTPException(status_code=400, detail="text_override must be non-empty when supplied")
            max_chars = int(payload.get("max_chars") or job.run_defaults.get("max_chars") or 220)
        else:
            max_chars = int(job.run_defaults.get("max_chars") or 220)

        variant_count = _validate_variant_count(payload.get("variant_count") or job.run_defaults.get("variant_count") or 3)
        backend = str(payload.get("backend") or job.run_defaults.get("backend") or job.backend)
        api_base = str(payload.get("api_base") or job.run_defaults.get("api_base") or job.api_base)
        prompt_name = str(payload.get("prompt_name") or job.prompt_name).strip()
        speed = float(payload.get("speed") or job.run_defaults.get("speed") or 1.0)
        pause_min_ms, pause_max_ms = _normalize_pause_range(
            pause_min_ms=payload.get("pause_min_ms"),
            pause_max_ms=payload.get("pause_max_ms"),
            pause_ms=payload.get("pause_ms"),
            fallback_min_ms=int(job.run_defaults.get("pause_min_ms") or 250),
            fallback_max_ms=int(job.run_defaults.get("pause_max_ms") or job.run_defaults.get("pause_ms") or 420),
        )
        pause_ms = pause_max_ms
        language = str(payload.get("language") or job.run_defaults.get("language") or "Auto")
        chunk_mode = str(job.run_defaults.get("chunk_mode") or "sentence")
        render_kwargs: dict[str, Any] = {}
        if _is_mock_api_base(api_base):
            _run_mock_regeneration(
                job=job,
                chunk_id=chunk_id,
                variant_count=variant_count,
                prompt_name=prompt_name,
                text_override=text_override,
            )
            with job._lock:
                job.total_generation_time = round((job.total_generation_time or 0) + (time.time() - started_at), 2)
            _set_job(job)
            return
        _ensure_prompt_available(api_base, prompt_name)
        with job._lock:
            job.total_work_units = max(1, variant_count)
            job.completed_work_units = 0
            job._completed_unit_ids.clear()
            job.status = "running"
            job.current_task = "Regenerating chunk"
            job.regeneration_requests.add(request_id)
            job.session.set_chunk_status(chunk_id, status="running", current_task="Regenerating chunk", error_message=None)
        _set_job(job)

        def progress_callback(event: dict[str, Any]) -> None:
            with job._lock:
                event_copy = {**event, "timestamp": _timestamp()}
                job.events.append(event_copy)
                event_type = str(event.get("type") or "")
                if event_type == "chunk_start":
                    event_chunk_id = str(event.get("chunk_id") or chunk_id)
                    chunk_started_at[event_chunk_id] = time.time()
                    job.session.set_chunk_status(event_chunk_id, status="running", current_task="Regenerating chunk", error_message=None)
                elif event_type == "regeneration_done":
                    unit_id = f"regen:{event.get('chunk_id') or chunk_id}:{event.get('regeneration_index') or 1}"
                    if unit_id not in job._completed_unit_ids:
                        job._completed_unit_ids.add(unit_id)
                        job.completed_work_units += 1
                    total = max(1, int(event.get("regeneration_total") or variant_count))
                    job.total_work_units = max(job.total_work_units, total)
                    job.progress_percent = _progress_percent(job.completed_work_units, job.total_work_units)
                    completed = job.completed_work_units
                    event_chunk_id = str(event.get("chunk_id") or chunk_id)
                    started = chunk_started_at.get(event_chunk_id)
                    generation_time = None if started is None else round(time.time() - started, 2)
                    job.session.set_chunk_status(event_chunk_id, status="completed", current_task="Ready", generation_time=generation_time, error_message=None)
                    job.current_task = f"Regenerated {completed}/{total} candidate sets"
            _set_job(job)

        controller.regenerate_chunk(
            session=job.session,
            chunk_id=chunk_id,
            variant_count=variant_count,
            api_base=api_base,
            prompt_name=prompt_name,
            chunk_mode=chunk_mode,
            max_chars=max_chars,
            speed=speed,
            pause_ms=pause_ms,
            pause_min_ms=pause_min_ms,
            pause_max_ms=pause_max_ms,
            output_root=Path(job.current_run_dir or DEFAULT_OUTPUT_ROOT),
            language=language,
            source_backend=backend,
            text_override=text_override,
            progress_callback=progress_callback,
            render_kwargs=render_kwargs,
            should_cancel=lambda: job.cancel_requested,
        )

        with job._lock:
            if not job.session.selections.get(chunk_id):
                candidates = job.session.chunk_candidates(chunk_id)
                if candidates:
                    job.session.select_candidate(chunk_id, candidates[0].candidate_id)
            if text_override:
                job.session.update_chunk_text(chunk_id, text_override)
            if job.cancel_requested:
                job.status = "canceled"
                job.current_task = "Run canceled"
            else:
                job.status = "completed" if _every_chunk_selected(job) else job.status
                job.current_task = "Chunk regeneration complete"
            job.total_generation_time = round((job.total_generation_time or 0) + (time.time() - started_at), 2)
        _set_job(job)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        with job._lock:
            job.session.set_chunk_status(chunk_id, status="failed", current_task="Chunk regeneration failed", error_message=str(exc))
            job.status = "failed"
            job.current_task = "Chunk regeneration failed"
            job.error_message = str(exc)
        _set_job(job)
        raise
    finally:
        if request_id:
            with job._lock:
                job.regeneration_requests.discard(request_id)


def _run_timeline_preview(job: JobState, request_id: str, clips: list[dict[str, Any]]) -> None:
    try:
        pause_min_ms, pause_max_ms = _normalize_pause_range(
            pause_min_ms=job.run_defaults.get("pause_min_ms"),
            pause_max_ms=job.run_defaults.get("pause_max_ms"),
            pause_ms=job.run_defaults.get("pause_ms"),
            fallback_min_ms=250,
            fallback_max_ms=420,
        )
        candidate_paths = [Path(clip["path"]) for clip in clips]
        with job._lock:
            chunk_texts = [job.session.get_chunk(str(clip["chunk_id"])).text for clip in clips]
        clip_segments = [{"trim_in_ms": int(clip["trim_in_ms"]), "trim_out_ms": int(clip["trim_out_ms"])} for clip in clips]
        preview_path = Path(job.current_run_dir or DEFAULT_OUTPUT_ROOT) / f"timeline_preview_{request_id}.wav"
        result = assemble_mix(
            candidate_paths=candidate_paths,
            chunk_texts=chunk_texts,
            output_path=preview_path,
            pause_ms=pause_max_ms,
            pause_min_ms=pause_min_ms,
            pause_max_ms=pause_max_ms,
            humanize_pause=True,
            clip_segments=clip_segments,
        )
        with job._lock:
            if job.timeline_request_id != request_id:
                return
            job.timeline_render_status = "preview_ready"
            job.timeline_render_error = None
            job.timeline_render_errors = []
            job.timeline_preview_mix_url = str(result)
        _set_job(job)
    except Exception as exc:  # noqa: BLE001
        with job._lock:
            if job.timeline_request_id != request_id:
                return
            job.timeline_render_status = "failed"
            job.timeline_render_error = str(exc)
            job.timeline_render_errors = [{"code": "timeline_preview_failed", "message": str(exc)}]
            job.timeline_preview_mix_url = None
        _set_job(job)


def _run_timeline_export(job: JobState, request_id: str, clips: list[dict[str, Any]], destination: Path) -> None:
    try:
        pause_min_ms, pause_max_ms = _normalize_pause_range(
            pause_min_ms=job.run_defaults.get("pause_min_ms"),
            pause_max_ms=job.run_defaults.get("pause_max_ms"),
            pause_ms=job.run_defaults.get("pause_ms"),
            fallback_min_ms=250,
            fallback_max_ms=420,
        )
        candidate_paths = [Path(clip["path"]) for clip in clips]
        with job._lock:
            chunk_texts = [job.session.get_chunk(str(clip["chunk_id"])).text for clip in clips]
        clip_segments = [{"trim_in_ms": int(clip["trim_in_ms"]), "trim_out_ms": int(clip["trim_out_ms"])} for clip in clips]
        result = export_mix(
            candidate_paths=candidate_paths,
            chunk_texts=chunk_texts,
            destination_path=destination,
            pause_ms=pause_max_ms,
            pause_min_ms=pause_min_ms,
            pause_max_ms=pause_max_ms,
            humanize_pause=True,
            clip_segments=clip_segments,
        )
        with job._lock:
            if job.timeline_request_id != request_id:
                return
            job.timeline_render_status = "export_ready"
            job.timeline_render_error = None
            job.timeline_render_errors = []
            job.timeline_export_path = str(result)
        _set_job(job)
    except Exception as exc:  # noqa: BLE001
        with job._lock:
            if job.timeline_request_id != request_id:
                return
            job.timeline_render_status = "failed"
            job.timeline_render_error = str(exc)
            job.timeline_render_errors = [{"code": "export_write_failed", "message": str(exc)}]
            job.timeline_export_path = None
        _set_job(job)


def _ensure_job_editable(job: JobState) -> None:
    with job._lock:
        if job.status not in {"completed", "failed", "canceled", "interrupted"}:
            raise HTTPException(status_code=409, detail="Chunk editing is only available on terminal runs")


def create_app() -> FastAPI:
    repository.mark_incomplete_runs_interrupted()
    app = FastAPI(title="Batch Audio Studio Bridge")
    bridge_token = str(os.environ.get("BATCH_AUDIO_BRIDGE_TOKEN") or "").strip()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=ALLOWED_BRIDGE_ORIGINS,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def require_bridge_token(request: Request, call_next):
        if request.method == "OPTIONS" or request.url.path == "/api/health" or not bridge_token:
            return await call_next(request)
        provided = str(request.headers.get("x-batch-audio-token") or "").strip()
        if not provided and request.url.path == "/api/media":
            provided = str(request.query_params.get("token") or "").strip()
        if provided != bridge_token:
            return JSONResponse(status_code=403, content={"detail": "Bridge token missing or invalid"})
        return await call_next(request)

    @app.exception_handler(TimelineValidationError)
    def handle_timeline_validation(_request, exc: TimelineValidationError):
        return _timeline_error_response(exc)

    @app.exception_handler(TimelineMissingError)
    def handle_timeline_missing(_request, exc: TimelineMissingError):
        return JSONResponse(status_code=404, content={"detail": exc.detail, "code": "missing_timeline_reference", "errors": []})

    @app.get("/api/health")
    def health() -> dict[str, Any]:
        return {"ok": True, "modal_api_base": modal_api_base(), "local_api_base": _local_api_base(), "mock_tts_enabled": ENABLE_MOCK_TTS}

    @app.get("/api/state")
    def state() -> dict[str, Any]:
        payload = _base_state_payload()
        payload["jobs"] = _state_jobs_payload()
        return payload

    @app.post("/api/voices/refresh")
    def refresh_voices() -> dict[str, Any]:
        _invalidate_prompt_cache()
        _invalidate_voice_state_cache()
        return _base_state_payload(force_refresh=True)

    @app.get("/api/voices")
    def voices() -> dict[str, Any]:
        return {"voices": _base_state_payload()["voices"]}

    @app.post("/api/voices/import")
    def import_voice(payload: dict[str, Any]) -> dict[str, Any]:
        name = str(payload.get("name") or "").strip()
        audio_path = str(payload.get("audio_path") or "").strip()
        if not name or not audio_path:
            raise HTTPException(status_code=400, detail="name and audio_path are required")
        source_audio_path = _validate_user_audio_input_path(audio_path)
        entry = voice_registry.save(
            name=name,
            audio_path=source_audio_path,
            ref_text=str(payload.get("ref_text") or ""),
            x_vector_only_mode=bool(payload.get("x_vector_only_mode")),
        )
        _invalidate_voice_state_cache()
        _invalidate_prompt_cache()
        return {"voice": entry, "voices": _base_state_payload(force_refresh=True)["voices"]}

    @app.post("/api/voices/sync")
    def sync_voice(payload: dict[str, Any]) -> dict[str, Any]:
        name = str(payload.get("name") or "").strip()
        api_base = str(payload.get("api_base") or "").strip() or _local_api_base()
        if not name or not api_base:
            raise HTTPException(status_code=400, detail="name and api_base are required")
        prompt = _ensure_prompt_available(api_base, name)
        _invalidate_voice_state_cache()
        _invalidate_prompt_cache(api_base)
        return {"prompt": prompt, "voices": _base_state_payload(force_refresh=True)["voices"]}

    @app.post("/api/voices/transcribe")
    def transcribe_voice(payload: dict[str, Any]) -> dict[str, Any]:
        audio_path = str(payload.get("audio_path") or "").strip()
        api_base = str(payload.get("api_base") or "").strip() or _local_api_base()
        if not audio_path or not api_base:
            raise HTTPException(status_code=400, detail="audio_path and api_base are required")
        if _is_mock_api_base(api_base):
            raise HTTPException(status_code=503, detail="Transcription requires a configured local or Modal backend")
        resolved_audio_path = _validate_user_audio_input_path(audio_path)
        uploaded = voice_clone_client.upload_reference_audio(api_base, resolved_audio_path)
        transcript = voice_clone_client.transcribe_reference_audio(
            api_base,
            str(uploaded.get("audio_base64") or ""),
            filename=resolved_audio_path.name,
        )
        return {"transcript": transcript}

    @app.post("/api/voices/save-clone")
    def save_clone(payload: dict[str, Any]) -> dict[str, Any]:
        name = str(payload.get("name") or "").strip()
        audio_path = str(payload.get("audio_path") or "").strip()
        api_base = str(payload.get("api_base") or "").strip() or _local_api_base()
        if not name or not audio_path or not api_base:
            raise HTTPException(status_code=400, detail="name, audio_path, and api_base are required")
        if _is_mock_api_base(api_base):
            raise HTTPException(status_code=503, detail="Saving cloned voices requires a configured local or Modal backend")
        resolved_audio_path = _validate_user_audio_input_path(audio_path)
        response = voice_clone_client.create_prompt(
            api_base=api_base,
            audio_path=resolved_audio_path,
            ref_text=str(payload.get("ref_text") or ""),
            name=name,
            x_vector_only_mode=bool(payload.get("x_vector_only_mode")),
        )
        voice_registry.save(
            name=name,
            audio_path=resolved_audio_path,
            ref_text=str(payload.get("ref_text") or ""),
            x_vector_only_mode=bool(payload.get("x_vector_only_mode")),
        )
        _invalidate_voice_state_cache()
        _invalidate_prompt_cache(api_base)
        return {"prompt": response, "voices": _base_state_payload(force_refresh=True)["voices"]}

    @app.post("/api/media/register-local-file")
    def register_local_media(payload: dict[str, Any]) -> dict[str, Any]:
        audio_path = str(payload.get("audio_path") or "").strip()
        if not audio_path:
            raise HTTPException(status_code=400, detail="audio_path is required")
        resolved_audio_path = _validate_user_audio_input_path(audio_path)
        media_id = _register_media_path(resolved_audio_path, trusted_external=True)
        query = f"id={media_id}"
        if bridge_token:
            query = f"{query}&token={bridge_token}"
        return {"media_url": f"/api/media?{query}"}

    @app.delete("/api/voices/{voice_name:path}")
    def delete_voice(voice_name: str) -> dict[str, Any]:
        name = voice_name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="voice name is required")
        voice = _find_voice_inventory_entry(name, force_refresh=True)
        if voice is None:
            raise HTTPException(status_code=404, detail=f"Voice '{name}' was not found")

        local_prompt_id = voice.get("local_prompt_id")
        modal_prompt_id = voice.get("modal_prompt_id")
        registry_entry = voice.get("registry_entry")
        if local_prompt_id == MOCK_LOCAL_PROMPT_ID or _is_builtin_prompt_id(local_prompt_id) or _is_builtin_prompt_id(modal_prompt_id):
            raise HTTPException(status_code=400, detail=f"Builtin voices like '{name}' cannot be deleted from the app.")

        deleted = False
        if local_prompt_id:
            local_base = _local_api_base()
            if _is_mock_api_base(local_base):
                raise HTTPException(status_code=503, detail="Local backend URL unavailable for voice deletion")
            voice_clone_client.delete_prompt(local_base, str(local_prompt_id))
            deleted = True
        if modal_prompt_id:
            modal_base = modal_api_base()
            if not modal_base:
                raise HTTPException(status_code=503, detail="Modal backend URL unavailable for voice deletion")
            voice_clone_client.delete_prompt(modal_base, str(modal_prompt_id))
            deleted = True
        if registry_entry is not None:
            deleted = bool(voice_registry.delete(name)) or deleted

        _invalidate_voice_state_cache()
        _invalidate_prompt_cache()
        return {"deleted": deleted, "voices": _base_state_payload(force_refresh=True)["voices"]}

    @app.post("/api/jobs")
    def create_job(payload: dict[str, Any]) -> dict[str, Any]:
        prompt_name = str(payload.get("prompt_name") or "").strip()
        api_base = str(payload.get("api_base") or "").strip() or _local_api_base()
        source_text = str(payload.get("text") or "").strip()
        backend = str(payload.get("backend") or ("mock" if _is_mock_api_base(api_base) else "local")).strip()
        if not prompt_name or not api_base or not source_text:
            raise HTTPException(status_code=400, detail="prompt_name, api_base, and text are required")
        pause_min_ms, pause_max_ms = _normalize_pause_range(
            pause_min_ms=payload.get("pause_min_ms"),
            pause_max_ms=payload.get("pause_max_ms"),
            pause_ms=payload.get("pause_ms"),
            fallback_min_ms=250,
            fallback_max_ms=420,
        )
        stamp = dt.datetime.now().strftime("studio_%Y%m%d_%H%M%S")
        run_dir = (DEFAULT_OUTPUT_ROOT / stamp).resolve()
        run_dir.mkdir(parents=True, exist_ok=True)
        job = JobState(
            job_id=f"job-{uuid.uuid4().hex[:10]}",
            run_id=f"job-{uuid.uuid4().hex[:10]}",
            prompt_name=prompt_name,
            voice_id=prompt_name,
            voice_display_name=prompt_name,
            run_label=_run_label(source_text),
            api_base=api_base,
            backend=backend,
            source_text=source_text,
            current_run_dir=run_dir,
            run_defaults={
                "api_base": api_base,
                "backend": backend,
                "variant_count": int(payload.get("variant_count") or 3),
                "chunk_mode": str(payload.get("chunk_mode") or "sentence"),
                "max_chars": int(payload.get("max_chars") or 220),
                "speed": float(payload.get("speed") or 1.0),
                "pause_ms": pause_max_ms,
                "pause_min_ms": pause_min_ms,
                "pause_max_ms": pause_max_ms,
                "language": str(payload.get("language") or "Auto"),
            },
        )
        job.run_id = job.job_id
        _set_job(job)
        threading.Thread(target=_run_generation, args=(job, payload), daemon=True).start()
        return _serialize_session(job)

    @app.post("/api/jobs/{job_id}/append")
    def append_to_job(job_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            job = _get_job(job_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"Unknown job {job_id}") from exc
        appended_chunk_ids = _append_to_job(job, payload)
        response = _serialize_session(job)
        response["appended_chunk_ids"] = appended_chunk_ids
        response["first_appended_chunk_id"] = appended_chunk_ids[0] if appended_chunk_ids else None
        return response

    @app.post("/api/jobs/{job_id}/label")
    def update_job_label(job_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            job = _get_job(job_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"Unknown job {job_id}") from exc
        run_label = str(payload.get("run_label") or "").strip()
        if not run_label:
            raise HTTPException(status_code=400, detail="run_label is required")
        with job._lock:
            job.run_label = run_label
        _set_job(job)
        return _serialize_session(job)

    @app.get("/api/jobs/{job_id}")
    def get_job(job_id: str) -> dict[str, Any]:
        try:
            return _serialize_session(_get_job(job_id))
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"Unknown job {job_id}") from exc

    @app.post("/api/jobs/{job_id}/select")
    def select_candidate(job_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            job = _get_job(job_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"Unknown job {job_id}") from exc
        with job._lock:
            job.session.select_candidate(str(payload.get("chunk_id")), str(payload.get("candidate_id")))
            _reset_timeline_state(job)
        _set_job(job)
        return _serialize_session(job)

    @app.post("/api/jobs/{job_id}/timeline/preview")
    def preview_timeline_for_job(job_id: str, payload: dict[str, Any]) -> JSONResponse:
        try:
            job = _get_job(job_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"Unknown job {job_id}") from exc
        if job.timeline_render_status in {"previewing", "exporting"}:
            return JSONResponse(status_code=409, content={"detail": "Timeline render already in progress", "code": "timeline_render_in_progress", "errors": []})
        request_id, clips, _ = _validate_timeline_payload(job, payload, require_export_path=False)
        with job._lock:
            job.timeline_render_status = "previewing"
            job.timeline_request_id = request_id
            job.timeline_render_error = None
            job.timeline_render_errors = []
            job.timeline_preview_mix_url = None
            job.timeline_export_path = None
        _set_job(job)
        threading.Thread(target=_run_timeline_preview, args=(job, request_id, clips), daemon=True).start()
        return JSONResponse(status_code=202, content={"request_id": request_id, "accepted": True})

    @app.post("/api/jobs/{job_id}/timeline/export")
    def export_timeline_for_job(job_id: str, payload: dict[str, Any]) -> JSONResponse:
        try:
            job = _get_job(job_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"Unknown job {job_id}") from exc
        if job.timeline_render_status in {"previewing", "exporting"}:
            return JSONResponse(status_code=409, content={"detail": "Timeline render already in progress", "code": "timeline_render_in_progress", "errors": []})
        request_id, clips, destination = _validate_timeline_payload(job, payload, require_export_path=True)
        assert destination is not None
        with job._lock:
            job.timeline_render_status = "exporting"
            job.timeline_request_id = request_id
            job.timeline_render_error = None
            job.timeline_render_errors = []
            job.timeline_preview_mix_url = None
            job.timeline_export_path = None
        _set_job(job)
        threading.Thread(target=_run_timeline_export, args=(job, request_id, clips, destination), daemon=True).start()
        return JSONResponse(status_code=202, content={"request_id": request_id, "accepted": True})

    @app.post("/api/jobs/{job_id}/cancel")
    def cancel_job(job_id: str) -> dict[str, Any]:
        try:
            job = _get_job(job_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"Unknown job {job_id}") from exc
        if job.status in {"completed", "failed", "canceled"}:
            return _serialize_session(job)
        with job._lock:
            job.cancel_requested = True
            job.status = "canceling"
            job.current_task = "Canceling run"
        _set_job(job)
        return _serialize_session(job)

    @app.delete("/api/jobs/{job_id}")
    def delete_job(job_id: str) -> dict[str, Any]:
        try:
            job = _get_job(job_id)
        except KeyError:
            deleted = repository.delete_run(job_id)
            return deleted
        if job.status not in {"completed", "failed", "canceled", "interrupted"}:
            raise HTTPException(status_code=409, detail="Only terminal runs can be deleted")
        deleted = repository.delete_run(job_id)
        with jobs_lock:
            jobs.pop(job_id, None)
        run_dir = deleted.get("run_dir")
        if run_dir:
            shutil.rmtree(run_dir, ignore_errors=True)
        return deleted

    @app.post("/api/jobs/{job_id}/chunks/{chunk_id}/regenerate")
    def regenerate_job_chunk(job_id: str, chunk_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            job = _get_job(job_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"Unknown job {job_id}") from exc
        try:
            job.session.get_chunk(chunk_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"Unknown chunk {chunk_id}") from exc
        _regenerate_chunk(job, chunk_id, payload)
        return _serialize_session(job)

    @app.post("/api/jobs/{job_id}/chunks")
    def add_job_chunk(job_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            job = _get_job(job_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"Unknown job {job_id}") from exc
        _ensure_job_editable(job)
        text = str(payload.get("text") or "").strip()
        if not text:
            raise HTTPException(status_code=400, detail="text is required")
        after_chunk_id = payload.get("after_chunk_id")
        if after_chunk_id is not None:
            after_chunk_id = str(after_chunk_id).strip() or None
        with job._lock:
            try:
                inserted = job.session.insert_chunk(text, after_chunk_id=after_chunk_id)
            except KeyError as exc:
                raise HTTPException(status_code=404, detail=f"Unknown chunk {after_chunk_id}") from exc
            _reset_timeline_state(job)
        _set_job(job)
        if not bool(payload.get("generate_versions", True)):
            return _serialize_session(job)
        _regenerate_chunk(
            job,
            inserted.chunk_id,
            {
                "request_id": str(payload.get("request_id") or f"chunk-add-{uuid.uuid4().hex[:10]}"),
                "text_override": text,
                "variant_count": int(payload.get("variant_count") or job.run_defaults.get("variant_count") or 1),
                "prompt_name": str(payload.get("prompt_name") or job.prompt_name),
                "backend": str(payload.get("backend") or job.backend),
                "api_base": str(payload.get("api_base") or job.api_base),
                "speed": float(payload.get("speed") or job.run_defaults.get("speed") or 1.0),
                "pause_ms": int(payload.get("pause_ms") or job.run_defaults.get("pause_max_ms") or job.run_defaults.get("pause_ms") or 420),
                "pause_min_ms": int(payload.get("pause_min_ms") or job.run_defaults.get("pause_min_ms") or 250),
                "pause_max_ms": int(payload.get("pause_max_ms") or job.run_defaults.get("pause_max_ms") or job.run_defaults.get("pause_ms") or 420),
                "max_chars": int(payload.get("max_chars") or job.run_defaults.get("max_chars") or 220),
                "language": str(payload.get("language") or job.run_defaults.get("language") or "Auto"),
            },
        )
        return _serialize_session(job)

    @app.post("/api/jobs/{job_id}/chunks/reorder")
    def reorder_job_chunks(job_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            job = _get_job(job_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"Unknown job {job_id}") from exc
        chunk_id = str(payload.get("chunk_id") or "").strip()
        if not chunk_id:
            raise HTTPException(status_code=400, detail="chunk_id is required")
        try:
            to_index = int(payload.get("to_index"))
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail="to_index must be an integer") from exc
        _reorder_job_chunk(job, chunk_id, to_index)
        return _serialize_session(job)

    @app.post("/api/jobs/{job_id}/chunks/{chunk_id}/text")
    def update_job_chunk_text(job_id: str, chunk_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            job = _get_job(job_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"Unknown job {job_id}") from exc
        _ensure_job_editable(job)
        text = str(payload.get("text") or "").strip()
        if not text:
            raise HTTPException(status_code=400, detail="text is required")
        with job._lock:
            try:
                job.session.update_chunk_text(chunk_id, text)
            except KeyError as exc:
                raise HTTPException(status_code=404, detail=f"Unknown chunk {chunk_id}") from exc
            _reset_timeline_state(job)
            job.current_task = "Updated chunk text"
        _set_job(job)
        return _serialize_session(job)

    @app.delete("/api/jobs/{job_id}/chunks/{chunk_id}")
    def delete_job_chunk(job_id: str, chunk_id: str) -> dict[str, Any]:
        try:
            job = _get_job(job_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"Unknown job {job_id}") from exc
        _ensure_job_editable(job)
        with job._lock:
            try:
                removed = job.session.delete_chunk(chunk_id)
            except KeyError as exc:
                raise HTTPException(status_code=404, detail=f"Unknown chunk {chunk_id}") from exc
            _reset_timeline_state(job)
            job.current_task = f"Removed chunk {removed.index}"
        _set_job(job)
        return _serialize_session(job)

    @app.delete("/api/jobs/{job_id}/chunks/{chunk_id}/candidates/{candidate_id}")
    def delete_job_chunk_candidate(job_id: str, chunk_id: str, candidate_id: str) -> dict[str, Any]:
        try:
            job = _get_job(job_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"Unknown job {job_id}") from exc
        _ensure_job_editable(job)
        with job._lock:
            try:
                removed = job.session.delete_candidate(chunk_id, candidate_id)
            except KeyError as exc:
                raise HTTPException(status_code=404, detail=f"Unknown candidate {candidate_id}") from exc

        for path in (removed.raw_path, removed.normalized_wav_path):
            try:
                Path(path).unlink(missing_ok=True)
            except Exception:  # noqa: BLE001
                pass
        with job._lock:
            _reset_timeline_state(job)
            job.current_task = f"Removed version {removed.variant_label}"
        _set_job(job)
        return _serialize_session(job)

    @app.post("/api/jobs/{job_id}/preview-mix")
    def preview_mix_for_job(job_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            job = _get_job(job_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"Unknown job {job_id}") from exc
        if not _every_chunk_selected(job):
            raise HTTPException(status_code=400, detail="Every chunk must have a selected candidate to preview")
        paths: list[Path] = []
        texts: list[str] = []
        with job._lock:
            for chunk in job.session.chunks:
                selected_id = job.session.selections.get(chunk.chunk_id)
                candidate = next(item for item in chunk.candidates if item.candidate_id == selected_id)
                paths.append(Path(candidate.normalized_wav_path))
                texts.append(chunk.text)
        if not paths:
            raise HTTPException(status_code=400, detail="No selected candidates to preview")
        pause_min_ms, pause_max_ms = _normalize_pause_range(
            pause_min_ms=payload.get("pause_min_ms"),
            pause_max_ms=payload.get("pause_max_ms"),
            pause_ms=payload.get("pause_ms"),
            fallback_min_ms=int(job.run_defaults.get("pause_min_ms") or 250),
            fallback_max_ms=int(job.run_defaults.get("pause_max_ms") or job.run_defaults.get("pause_ms") or 420),
        )
        preview_path = Path(job.current_run_dir or DEFAULT_OUTPUT_ROOT) / "assembled_preview.wav"
        preview_mix_path = assemble_mix(
            candidate_paths=paths,
            chunk_texts=texts,
            output_path=preview_path,
            pause_ms=pause_max_ms,
            pause_min_ms=pause_min_ms,
            pause_max_ms=pause_max_ms,
            humanize_pause=True,
        )
        with job._lock:
            job.preview_mix_path = preview_mix_path
        _set_job(job)
        return {"preview_mix_url": _media_url_for_path(job.preview_mix_path)}

    @app.post("/api/jobs/{job_id}/export")
    def export_for_job(job_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            job = _get_job(job_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"Unknown job {job_id}") from exc
        destination = str(payload.get("destination_path") or "").strip()
        if not destination:
            raise HTTPException(status_code=400, detail="destination_path is required")
        destination_path = _validate_user_export_path(destination)
        if not _every_chunk_selected(job):
            raise HTTPException(status_code=400, detail="Every chunk must have a selected candidate to export")
        paths: list[Path] = []
        texts: list[str] = []
        with job._lock:
            for chunk in job.session.chunks:
                selected_id = job.session.selections.get(chunk.chunk_id)
                candidate = next(item for item in chunk.candidates if item.candidate_id == selected_id)
                paths.append(Path(candidate.normalized_wav_path))
                texts.append(chunk.text)
        pause_min_ms, pause_max_ms = _normalize_pause_range(
            pause_min_ms=payload.get("pause_min_ms"),
            pause_max_ms=payload.get("pause_max_ms"),
            pause_ms=payload.get("pause_ms"),
            fallback_min_ms=int(job.run_defaults.get("pause_min_ms") or 250),
            fallback_max_ms=int(job.run_defaults.get("pause_max_ms") or job.run_defaults.get("pause_ms") or 420),
        )
        exported = export_mix(
            candidate_paths=paths,
            chunk_texts=texts,
            destination_path=destination_path,
            pause_ms=pause_max_ms,
            pause_min_ms=pause_min_ms,
            pause_max_ms=pause_max_ms,
            humanize_pause=True,
        )
        return {"destination_path": str(exported)}

    @app.get("/api/media")
    def media(id: str = Query(...)):
        with media_lock:
            target = media_paths_by_id.get(id)
            is_trusted_external = id in trusted_external_media_ids
        if target is None:
            raise HTTPException(status_code=404, detail="Unknown media resource")
        target = target.expanduser().resolve()
        if not is_trusted_external and not _is_allowed_media_path(target):
            raise HTTPException(status_code=403, detail="Media path is not accessible")
        if not target.exists():
            raise HTTPException(status_code=404, detail=f"Missing file {target}")
        return FileResponse(target)

    return app


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Batch Audio Studio local bridge")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=int(os.environ.get("BATCH_AUDIO_BRIDGE_PORT", "42111")))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    uvicorn.run(create_app(), host=args.host, port=args.port, log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
