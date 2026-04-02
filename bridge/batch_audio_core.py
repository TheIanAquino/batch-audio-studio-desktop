#!/usr/bin/env python3
from __future__ import annotations

import base64
import datetime as dt
import json
import os
import pathlib
import re
import subprocess
import urllib.error
import urllib.parse
import urllib.request
import wave
from dataclasses import dataclass
from typing import Any, Callable

from batch_audio_backends import default_api_base
from config import bridge_runs_root, load_env

load_env()


DEFAULT_API_BASE = default_api_base()
DEFAULT_PROMPT_NAME = "Craig Campbell"
DEFAULT_SPEED = 1.0
DEFAULT_LANGUAGE = "Auto"
DEFAULT_OUTPUT_ROOT = bridge_runs_root()
DEFAULT_TIMEOUT_SECONDS = 300


@dataclass
class ClipResult:
    index: int
    text: str
    path: pathlib.Path
    status: str


@dataclass
class RenderResult:
    output_dir: pathlib.Path
    prompt_id: str
    chunks: list[str]
    clips: list[ClipResult]
    joined_file: pathlib.Path | None
    manifest_path: pathlib.Path


def normalize_text(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = text.replace("\u201c", '"').replace("\u201d", '"')
    text = text.replace("\u2018", "'").replace("\u2019", "'")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def split_sentences(text: str) -> list[str]:
    if not text:
        return []
    protected = text.replace("U.S.", "__US_ABBR__").replace("u.s.", "__us_abbr__")
    parts = re.split(r"(?<=[.!?])\s+", protected)
    return [part.strip().replace("__US_ABBR__", "U.S.").replace("__us_abbr__", "u.s.") for part in parts if part.strip()]


def force_split(text: str, max_chars: int) -> list[str]:
    words = text.split()
    if not words:
        return []
    chunks = [words[0]]
    for word in words[1:]:
        candidate = f"{chunks[-1]} {word}"
        if len(candidate) <= max_chars:
            chunks[-1] = candidate
        else:
            chunks.append(word)
    return chunks


def chunk_text(text: str, mode: str, max_chars: int) -> list[str]:
    paragraphs = [block.strip() for block in text.split("\n\n") if block.strip()]
    chunks: list[str] = []
    for paragraph in paragraphs:
        if mode == "line":
            units = [line.strip() for line in paragraph.splitlines() if line.strip()]
        else:
            units = split_sentences(paragraph) or [paragraph]
        if mode == "pair":
            paired: list[str] = []
            index = 0
            while index < len(units):
                candidate = units[index]
                if index + 1 < len(units):
                    candidate = f"{candidate} {units[index + 1]}".strip()
                    index += 1
                paired.append(candidate)
                index += 1
            units = paired
        if mode in {"sentence", "pair"}:
            chunks.extend(units)
            continue
        for unit in units:
            chunks.extend([unit] if len(unit) <= max_chars else force_split(unit, max_chars))
    return [chunk for chunk in chunks if chunk.strip()]


def ensure_output_dir(output_dir: str | pathlib.Path | None = None) -> pathlib.Path:
    if output_dir:
        path = pathlib.Path(output_dir).expanduser().resolve()
    else:
        stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
        path = (DEFAULT_OUTPUT_ROOT / stamp).resolve()
    path.mkdir(parents=True, exist_ok=True)
    return path


def request_json(method: str, url: str, payload: dict[str, Any] | None, timeout: int) -> dict[str, Any]:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {"Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code} for {url}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Unable to reach {url}: {exc.reason}") from exc
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Expected JSON from {url}, got: {raw[:300]}") from exc


def fetch_saved_prompts(api_base: str = DEFAULT_API_BASE, timeout: int = DEFAULT_TIMEOUT_SECONDS) -> list[dict[str, Any]]:
    prompts_url = urllib.parse.urljoin(api_base.rstrip("/") + "/", "api/v1/base/prompts")
    return request_json("GET", prompts_url, None, timeout).get("prompts", [])


def resolve_prompt_id(api_base: str, prompt_id: str | None, prompt_name: str, timeout: int) -> str:
    if prompt_id:
        return prompt_id
    prompts = fetch_saved_prompts(api_base, timeout)
    for prompt in prompts:
        if prompt.get("name") == prompt_name:
            return str(prompt["prompt_id"])
    available = ", ".join(sorted(prompt.get("name", "") for prompt in prompts if prompt.get("name")))
    raise RuntimeError(f"Prompt named '{prompt_name}' was not found. Available prompts: {available or 'none'}")


def decode_audio_payload(data: dict[str, Any]) -> bytes:
    for key in ("audio_base64", "base64_audio", "audio", "data"):
        value = data.get(key)
        if isinstance(value, str) and value:
            if value.startswith("data:") and "," in value:
                value = value.split(",", 1)[1]
            return base64.b64decode(value)
    raise RuntimeError(f"No base64 audio field found in response keys: {sorted(data.keys())}")


def detect_extension(audio_bytes: bytes, preferred: str) -> str:
    if audio_bytes.startswith(b"RIFF"):
        return "wav"
    if audio_bytes[:3] == b"ID3" or audio_bytes[:2] in {b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"}:
        return "mp3"
    return preferred


def synthesize_chunk(
    api_base: str,
    prompt_id: str,
    text: str,
    speed: float,
    language: str,
    timeout: int,
) -> dict[str, Any]:
    url = urllib.parse.urljoin(api_base.rstrip("/") + "/", "api/v1/base/generate-with-prompt")
    payload = {
        "prompt_id": prompt_id,
        "text": text,
        "language": language,
        "speed": speed,
        "response_format": "base64",
    }
    return request_json("POST", url, payload, timeout)


def synthesize_clone_chunk(
    api_base: str,
    ref_audio_base64: str,
    ref_text: str,
    text: str,
    speed: float,
    language: str,
    timeout: int,
    *,
    x_vector_only_mode: bool = False,
) -> dict[str, Any]:
    url = urllib.parse.urljoin(api_base.rstrip("/") + "/", "api/v1/base/clone")
    payload = {
        "text": text,
        "language": language,
        "ref_audio_base64": ref_audio_base64,
        "ref_text": ref_text,
        "x_vector_only_mode": x_vector_only_mode,
        "speed": speed,
        "response_format": "base64",
    }
    return request_json("POST", url, payload, timeout)


def _stable_hash_u32(value: str) -> int:
    hash_value = 2166136261
    for byte in value.encode("utf-8"):
        hash_value ^= byte
        hash_value = (hash_value * 16777619) & 0xFFFFFFFF
    return hash_value


def _resolve_pause_range(pause_ms: int, pause_min_ms: int | None, pause_max_ms: int | None) -> tuple[int, int]:
    fallback = max(0, int(pause_ms))
    minimum = fallback if pause_min_ms is None else max(0, int(pause_min_ms))
    maximum = fallback if pause_max_ms is None else max(0, int(pause_max_ms))
    if minimum > maximum:
        minimum, maximum = maximum, minimum
    return minimum, maximum


def _pause_ms_for_transition(
    previous_text: str,
    gap_index: int,
    default_pause_ms: int,
    humanize: bool,
    *,
    pause_min_ms: int | None = None,
    pause_max_ms: int | None = None,
) -> int:
    minimum, maximum = _resolve_pause_range(default_pause_ms, pause_min_ms, pause_max_ms)
    if minimum == maximum:
        return minimum
    if not humanize:
        return round((minimum + maximum) / 2)
    seed = _stable_hash_u32(f"{gap_index}:{previous_text.strip()}")
    span = (maximum - minimum) + 1
    return minimum + (seed % span)


def join_wav_files(
    chunk_paths: list[pathlib.Path],
    chunk_texts: list[str],
    output_path: pathlib.Path,
    pause_ms: int,
    humanize_pause: bool = True,
    *,
    pause_min_ms: int | None = None,
    pause_max_ms: int | None = None,
) -> bool:
    if not chunk_paths or any(path.suffix.lower() != ".wav" for path in chunk_paths):
        return False
    params = None
    frames: list[bytes] = []
    for wav_path in chunk_paths:
        with wave.open(str(wav_path), "rb") as source:
            current_params = source.getparams()
            if params is None:
                params = current_params
            elif (current_params.nchannels, current_params.sampwidth, current_params.framerate, current_params.comptype) != (
                params.nchannels,
                params.sampwidth,
                params.framerate,
                params.comptype,
            ):
                return False
            frames.append(source.readframes(source.getnframes()))
    if params is None:
        return False
    with wave.open(str(output_path), "wb") as target:
        target.setparams(params)
        for index, frame_blob in enumerate(frames):
            if index:
                current_pause = _pause_ms_for_transition(
                    chunk_texts[index - 1],
                    index - 1,
                    pause_ms,
                    humanize_pause,
                    pause_min_ms=pause_min_ms,
                    pause_max_ms=pause_max_ms,
                )
                silence_frames = int(params.framerate * current_pause / 1000)
                silence = b"\x00" * silence_frames * params.sampwidth * params.nchannels
                target.writeframes(silence)
            target.writeframes(frame_blob)
    return True


def which(executable: str) -> str | None:
    for directory in os.environ.get("PATH", "").split(os.pathsep):
        candidate = pathlib.Path(directory) / executable
        if candidate.exists() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def join_with_ffmpeg(chunk_paths: list[pathlib.Path], output_path: pathlib.Path) -> bool:
    ffmpeg = which("ffmpeg")
    if not ffmpeg or not chunk_paths:
        return False
    list_path = output_path.with_suffix(".ffmpeg.txt")
    list_path.write_text("\n".join(f"file '{str(path.resolve()).replace("'", "'\\''")}'" for path in chunk_paths) + "\n", encoding="utf-8")
    try:
        result = subprocess.run(
            [ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", str(list_path), "-c", "copy", str(output_path)],
            check=False,
            capture_output=True,
            text=True,
        )
    finally:
        if list_path.exists():
            list_path.unlink()
    return result.returncode == 0


def play_audio(path: pathlib.Path) -> subprocess.Popen[str] | None:
    afplay = which("afplay")
    if not afplay:
        return None
    return subprocess.Popen([afplay, str(path)])


def export_audio(source_path: pathlib.Path, destination_path: pathlib.Path) -> pathlib.Path:
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    destination_path.write_bytes(source_path.read_bytes())
    return destination_path


def build_manifest(
    api_base: str,
    prompt_name: str,
    prompt_id: str,
    chunk_mode: str,
    max_chars: int,
    speed: float,
    language: str,
    source_text: str,
    chunks: list[str],
    clips: list[ClipResult],
    joined_file: pathlib.Path | None,
) -> dict[str, Any]:
    return {
        "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "api_base": api_base,
        "prompt_name": prompt_name,
        "prompt_id": prompt_id,
        "chunk_mode": chunk_mode,
        "max_chars": max_chars,
        "speed": speed,
        "language": language,
        "source_text": source_text,
        "chunks": chunks,
        "outputs": [
            {"index": clip.index, "text": clip.text, "path": str(clip.path), "status": clip.status}
            for clip in clips
        ],
        "joined_file": str(joined_file) if joined_file else None,
    }


def render_batch(
    *,
    text: str,
    api_base: str = DEFAULT_API_BASE,
    prompt_name: str = DEFAULT_PROMPT_NAME,
    prompt_id: str | None = None,
    chunk_mode: str = "sentence",
    max_chars: int = 220,
    speed: float = DEFAULT_SPEED,
    language: str = DEFAULT_LANGUAGE,
    output_dir: str | pathlib.Path | None = None,
    prefix: str = "chunk",
    audio_format: str = "wav",
    join_audio: bool = False,
    pause_ms: int = 420,
    pause_min_ms: int | None = None,
    pause_max_ms: int | None = None,
    humanize_pause: bool = True,
    resume: bool = False,
    timeout: int = DEFAULT_TIMEOUT_SECONDS,
    progress_callback: Callable[[dict[str, Any]], None] | None = None,
    ref_audio_path: str | pathlib.Path | None = None,
    ref_text: str = "",
    x_vector_only_mode: bool = False,
) -> RenderResult:
    normalized = normalize_text(text)
    chunks = chunk_text(normalized, chunk_mode, max_chars)
    if not chunks:
        raise RuntimeError("No non-empty chunks were produced from the input text.")
    out_dir = ensure_output_dir(output_dir)
    direct_clone_audio_base64 = None
    if ref_audio_path is not None:
        audio_path = pathlib.Path(ref_audio_path).expanduser().resolve()
        direct_clone_audio_base64 = base64.b64encode(audio_path.read_bytes()).decode("ascii")
        resolved_prompt_id = f"direct-clone:{prompt_name}"
    else:
        resolved_prompt_id = resolve_prompt_id(api_base, prompt_id, prompt_name, timeout)
    clips: list[ClipResult] = []
    clip_paths: list[pathlib.Path] = []
    total = len(chunks)
    for index, chunk in enumerate(chunks, start=1):
        if progress_callback:
            progress_callback({"type": "chunk_start", "index": index, "total": total, "text": chunk})
        base_name = f"{prefix}_{index:03d}"
        existing = sorted(out_dir.glob(f"{base_name}.*"))
        if resume and existing:
            clip = ClipResult(index=index, text=chunk, path=existing[0], status="reused")
        else:
            if direct_clone_audio_base64 is not None:
                response = synthesize_clone_chunk(
                    api_base,
                    direct_clone_audio_base64,
                    ref_text,
                    chunk,
                    speed,
                    language,
                    timeout,
                    x_vector_only_mode=x_vector_only_mode,
                )
            else:
                response = synthesize_chunk(api_base, resolved_prompt_id, chunk, speed, language, timeout)
            audio_bytes = decode_audio_payload(response)
            extension = detect_extension(audio_bytes, audio_format)
            output_path = out_dir / f"{base_name}.{extension}"
            output_path.write_bytes(audio_bytes)
            clip = ClipResult(index=index, text=chunk, path=output_path, status="generated")
        clips.append(clip)
        clip_paths.append(clip.path)
        if progress_callback:
            progress_callback({"type": "chunk_done", "index": index, "total": total, "text": chunk, "path": str(clip.path), "status": clip.status})
    joined_file: pathlib.Path | None = None
    if join_audio and clip_paths:
        joined_candidate = out_dir / "joined.wav"
        if join_wav_files(
            clip_paths,
            chunks,
            joined_candidate,
            pause_ms,
            humanize_pause,
            pause_min_ms=pause_min_ms,
            pause_max_ms=pause_max_ms,
        ):
            joined_file = joined_candidate
        else:
            alt = out_dir / f"joined.{clip_paths[0].suffix.lower().lstrip('.') or audio_format}"
            if join_with_ffmpeg(clip_paths, alt):
                joined_file = alt
        if progress_callback:
            progress_callback({"type": "join_done", "path": str(joined_file) if joined_file else None})
    manifest = build_manifest(api_base, prompt_name, resolved_prompt_id, chunk_mode, max_chars, speed, language, normalized, chunks, clips, joined_file)
    manifest_path = out_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    if progress_callback:
        progress_callback({"type": "manifest_done", "path": str(manifest_path)})
    return RenderResult(output_dir=out_dir, prompt_id=resolved_prompt_id, chunks=chunks, clips=clips, joined_file=joined_file, manifest_path=manifest_path)
