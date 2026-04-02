#!/usr/bin/env python3
from __future__ import annotations

import shutil
import subprocess
import tempfile
import wave
from pathlib import Path

from batch_audio_core import join_wav_files, which


def normalize_candidate_to_wav(source_path: Path, destination_path: Path) -> Path:
    source = Path(source_path).expanduser().resolve()
    destination = Path(destination_path).expanduser().resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)

    if source.suffix.lower() == ".wav":
        if source != destination:
            shutil.copyfile(source, destination)
        return destination

    ffmpeg = which("ffmpeg")
    if ffmpeg:
        result = subprocess.run(
            [ffmpeg, "-y", "-loglevel", "error", "-i", str(source), str(destination)],
            check=False,
            capture_output=True,
            text=True,
        )
        if result.returncode == 0 and destination.exists():
            return destination

    afconvert = which("afconvert")
    if afconvert:
        result = subprocess.run(
            [afconvert, "-f", "WAVE", "-d", "LEI16@16000", str(source), str(destination)],
            check=False,
            capture_output=True,
            text=True,
        )
        if result.returncode == 0 and destination.exists():
            return destination

    raise RuntimeError(f"Could not normalize {source.name} to WAV.")


def assemble_mix(
    *,
    candidate_paths: list[Path],
    chunk_texts: list[str],
    output_path: Path,
    pause_ms: int,
    pause_min_ms: int | None = None,
    pause_max_ms: int | None = None,
    humanize_pause: bool = True,
    clip_segments: list[dict[str, int]] | None = None,
) -> Path:
    if len(candidate_paths) != len(chunk_texts):
        raise RuntimeError("Candidate path count must match chunk text count.")
    if clip_segments is not None and len(clip_segments) != len(candidate_paths):
        raise RuntimeError("Clip segment count must match candidate path count.")

    output = Path(output_path).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="batch-audio-mix-") as temp_dir:
        normalized_paths = []
        for index, path in enumerate(candidate_paths, start=1):
            normalized = normalize_candidate_to_wav(path, Path(temp_dir) / f"candidate_{index:03d}.wav")
            segment = clip_segments[index - 1] if clip_segments is not None else None
            if segment is None:
                normalized_paths.append(normalized)
                continue
            trimmed = Path(temp_dir) / f"candidate_{index:03d}.trimmed.wav"
            normalized_paths.append(_trim_wav_segment(normalized, trimmed, trim_in_ms=int(segment.get("trim_in_ms", 0)), trim_out_ms=int(segment.get("trim_out_ms", 0))))
        if not join_wav_files(
            normalized_paths,
            chunk_texts,
            output,
            pause_ms,
            humanize_pause,
            pause_min_ms=pause_min_ms,
            pause_max_ms=pause_max_ms,
        ):
            raise RuntimeError("Could not assemble a WAV mix from the selected clips.")
    return output


def export_mix(
    *,
    candidate_paths: list[Path],
    chunk_texts: list[str],
    destination_path: Path,
    pause_ms: int,
    pause_min_ms: int | None = None,
    pause_max_ms: int | None = None,
    humanize_pause: bool = True,
    clip_segments: list[dict[str, int]] | None = None,
) -> Path:
    return assemble_mix(
        candidate_paths=candidate_paths,
        chunk_texts=chunk_texts,
        output_path=destination_path,
        pause_ms=pause_ms,
        pause_min_ms=pause_min_ms,
        pause_max_ms=pause_max_ms,
        humanize_pause=humanize_pause,
        clip_segments=clip_segments,
    )


def _trim_wav_segment(source_path: Path, destination_path: Path, *, trim_in_ms: int, trim_out_ms: int) -> Path:
    with wave.open(str(source_path), "rb") as source:
        params = source.getparams()
        total_frames = source.getnframes()
        start_frame = max(0, int(params.framerate * trim_in_ms / 1000))
        end_frame = max(start_frame, total_frames - max(0, int(params.framerate * trim_out_ms / 1000)))
        source.setpos(min(start_frame, total_frames))
        frames = source.readframes(max(0, end_frame - start_frame))

    with wave.open(str(destination_path), "wb") as target:
        target.setparams(params)
        target.writeframes(frames)

    return destination_path
