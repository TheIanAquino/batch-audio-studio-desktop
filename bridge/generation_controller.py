#!/usr/bin/env python3
from __future__ import annotations

import datetime as dt
import os
import shutil
import threading
import uuid
import wave
from concurrent.futures import CancelledError, Future, ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Callable

from audio_pipeline import normalize_candidate_to_wav
from batch_audio_core import RenderResult, chunk_text, join_wav_files, join_with_ffmpeg, render_batch, resolve_prompt_id
from studio_session import CandidateRecord, StudioSession


class GenerationController:
    def __init__(
        self,
        *,
        render_batch_fn: Callable[..., RenderResult] = render_batch,
        normalize_candidate_fn: Callable[[Path, Path], Path] = normalize_candidate_to_wav,
        modal_max_concurrency: int | None = None,
    ) -> None:
        self.render_batch_fn = render_batch_fn
        self.normalize_candidate_fn = normalize_candidate_fn
        self.modal_max_concurrency = max(1, int(modal_max_concurrency or os.environ.get("BATCH_AUDIO_MODAL_TASK_CONCURRENCY", "10")))
        self._modal_executor = ThreadPoolExecutor(max_workers=self.modal_max_concurrency, thread_name_prefix="modal-batch-audio")
        self._modal_pool_lock = threading.Lock()
        self._modal_in_flight = 0

    def modal_pool_snapshot(self) -> dict[str, int]:
        with self._modal_pool_lock:
            in_flight = int(self._modal_in_flight)
        queued = int(getattr(self._modal_executor, "_work_queue", None).qsize()) if getattr(self._modal_executor, "_work_queue", None) is not None else 0
        return {
            "in_flight": max(0, in_flight),
            "queued": max(0, queued),
            "max": int(self.modal_max_concurrency),
        }

    def _submit_modal_task(self, fn: Callable[..., Any], **kwargs: Any) -> Future:
        with self._modal_pool_lock:
            self._modal_in_flight += 1
        future = self._modal_executor.submit(fn, **kwargs)

        def _on_done(_future: Future) -> None:
            with self._modal_pool_lock:
                self._modal_in_flight = max(0, self._modal_in_flight - 1)

        future.add_done_callback(_on_done)
        return future

    @staticmethod
    def _cancel_pending_futures(futures: list[Future]) -> None:
        for future in futures:
            if not future.done():
                future.cancel()

    def generate_full_batch(
        self,
        *,
        session: StudioSession,
        text: str,
        variant_count: int,
        api_base: str,
        prompt_name: str,
        chunk_mode: str,
        max_chars: int,
        speed: float,
        pause_ms: int,
        pause_min_ms: int | None = None,
        pause_max_ms: int | None = None,
        output_root: Path,
        language: str = "Auto",
        source_backend: str | None = None,
        progress_callback: Callable[[dict], None] | None = None,
        render_kwargs: dict[str, Any] | None = None,
        should_cancel: Callable[[], bool] | None = None,
    ) -> None:
        effective_variant_count = max(1, int(variant_count))
        batch_id = f"batch-{dt.datetime.now().strftime('%Y%m%d%H%M%S')}-{uuid.uuid4().hex[:8]}"
        effective_chunks = chunk_text(text, chunk_mode, max_chars)
        if effective_chunks:
            session.set_chunks(effective_chunks, source_text=text)

        if source_backend == "modal":
            self._generate_full_batch_modal(
                session=session,
                chunks=effective_chunks,
                variant_count=effective_variant_count,
                api_base=api_base,
                prompt_name=prompt_name,
                max_chars=max_chars,
                speed=speed,
                pause_ms=pause_ms,
                pause_min_ms=pause_min_ms,
                pause_max_ms=pause_max_ms,
                output_root=output_root,
                language=language,
                progress_callback=progress_callback,
                render_kwargs=render_kwargs or {},
                should_cancel=should_cancel,
                source_batch_id=batch_id,
                source_backend=source_backend,
            )
            return

        render_results = self._run_render_tasks(
            tasks=[
                (
                    variant_index,
                    {
                        "text": text,
                        "api_base": api_base,
                        "prompt_name": prompt_name,
                        "chunk_mode": chunk_mode,
                        "max_chars": max_chars,
                        "speed": speed,
                        "language": language,
                        "output_dir": Path(output_root) / f"variant_{variant_index:02d}",
                        "prefix": f"v{variant_index}_chunk",
                        "join_audio": True,
                        "pause_ms": pause_ms,
                        "pause_min_ms": pause_min_ms,
                        "pause_max_ms": pause_max_ms,
                        "humanize_pause": True,
                        "progress_callback": (
                            None
                            if progress_callback is None
                            else self._wrap_progress_callback(
                                session=session,
                                progress_callback=progress_callback,
                                progress_context={"variant": variant_index, "variant_total": effective_variant_count, "mode": "full_batch"},
                                source_batch_id=batch_id,
                                variant_label=f"V{variant_index}",
                                source_prompt_name=prompt_name,
                                source_backend=source_backend,
                                source_api_base=api_base,
                            )
                        ),
                        **(render_kwargs or {}),
                    },
                )
                for variant_index in range(1, effective_variant_count + 1)
            ],
            source_backend=source_backend,
            should_cancel=should_cancel,
        )

        for variant_index, result in render_results:
            session.add_candidates(
                self._build_candidates(
                    session,
                    result,
                    batch_id,
                    f"V{variant_index}",
                    source_prompt_name=prompt_name,
                    source_backend=source_backend,
                    source_api_base=api_base,
                )
            )
            if progress_callback:
                progress_callback(
                    {
                        "type": "variant_done",
                        "variant": variant_index,
                        "variant_total": effective_variant_count,
                        "mode": "full_batch",
                    }
                )

    def regenerate_chunk(
        self,
        *,
        session: StudioSession,
        chunk_id: str,
        variant_count: int,
        api_base: str,
        prompt_name: str,
        chunk_mode: str,
        max_chars: int,
        speed: float,
        pause_ms: int,
        pause_min_ms: int | None = None,
        pause_max_ms: int | None = None,
        output_root: Path,
        language: str = "Auto",
        source_backend: str | None = None,
        text_override: str | None = None,
        progress_callback: Callable[[dict], None] | None = None,
        render_kwargs: dict[str, Any] | None = None,
        should_cancel: Callable[[], bool] | None = None,
    ) -> None:
        target_chunk = next(chunk for chunk in session.chunks if chunk.chunk_id == chunk_id)
        rerun_batch_id = f"rerun-{target_chunk.index:03d}-{uuid.uuid4().hex[:8]}"
        effective_text = (text_override or target_chunk.text).strip()

        render_results = self._run_render_tasks(
            tasks=[
                (
                    candidate_index,
                    {
                        "text": effective_text,
                        "api_base": api_base,
                        "prompt_name": prompt_name,
                        "chunk_mode": chunk_mode,
                        "max_chars": max_chars,
                        "speed": speed,
                        "language": language,
                        "output_dir": Path(output_root) / f"chunk_{target_chunk.index:02d}_rerun_{candidate_index:02d}",
                        "prefix": f"chunk_{target_chunk.index:02d}_rerun_{candidate_index:02d}",
                        "join_audio": True,
                        "pause_ms": pause_ms,
                        "pause_min_ms": pause_min_ms,
                        "pause_max_ms": pause_max_ms,
                        "humanize_pause": True,
                        "progress_callback": (
                            None
                            if progress_callback is None
                            else self._wrap_progress_callback(
                                session=session,
                                progress_callback=progress_callback,
                                progress_context={"regeneration_index": candidate_index, "regeneration_total": variant_count, "chunk_id": chunk_id, "mode": "chunk_regeneration"},
                                source_batch_id=rerun_batch_id,
                                variant_label=f"R{candidate_index}",
                                forced_chunk_id=chunk_id,
                                source_prompt_name=prompt_name,
                                source_backend=source_backend,
                                source_api_base=api_base,
                            )
                        ),
                        **(render_kwargs or {}),
                    },
                )
                for candidate_index in range(1, int(variant_count) + 1)
            ],
            source_backend=source_backend,
            should_cancel=should_cancel,
        )

        for candidate_index, result in render_results:
            session.add_candidates(
                self._build_candidates(
                    session,
                    result,
                    rerun_batch_id,
                    f"R{candidate_index}",
                    forced_chunk_id=chunk_id,
                    source_prompt_name=prompt_name,
                    source_backend=source_backend,
                    source_api_base=api_base,
                )
            )
            if progress_callback:
                progress_callback(
                    {
                        "type": "regeneration_done",
                        "regeneration_index": candidate_index,
                        "regeneration_total": int(variant_count),
                        "chunk_id": chunk_id,
                        "mode": "chunk_regeneration",
                    }
                )

    def _generate_full_batch_modal(
        self,
        *,
        session: StudioSession,
        chunks: list[str],
        variant_count: int,
        api_base: str,
        prompt_name: str,
        max_chars: int,
        speed: float,
        pause_ms: int,
        pause_min_ms: int | None,
        pause_max_ms: int | None,
        output_root: Path,
        language: str,
        progress_callback: Callable[[dict], None] | None,
        render_kwargs: dict[str, Any],
        should_cancel: Callable[[], bool] | None,
        source_batch_id: str,
        source_backend: str | None,
    ) -> None:
        if not chunks:
            return
        resolved_prompt_id: str | None = None
        try:
            resolved_prompt_id = resolve_prompt_id(api_base, None, prompt_name, int(render_kwargs.get("timeout", 300)))
        except Exception:  # noqa: BLE001
            # Test doubles use non-network render functions and don't need prompt lookup.
            if self.render_batch_fn is render_batch:
                raise
        chunk_total = len(chunks)
        chunk_paths_by_variant: dict[int, dict[int, Path]] = {variant_index: {} for variant_index in range(1, variant_count + 1)}
        variant_done_counts: dict[int, int] = {variant_index: 0 for variant_index in range(1, variant_count + 1)}
        futures: dict[Future[tuple[int, int, str, Path]], tuple[int, int]] = {}

        stop_dispatch = False
        for variant_index in range(1, variant_count + 1):
            for chunk_index, chunk_text_value in enumerate(chunks, start=1):
                if should_cancel and should_cancel():
                    stop_dispatch = True
                    break
                if progress_callback:
                    progress_callback(
                        {
                            "type": "chunk_start",
                            "index": chunk_index,
                            "total": chunk_total,
                            "text": chunk_text_value,
                            "variant": variant_index,
                            "variant_total": variant_count,
                            "mode": "full_batch",
                        }
                    )
                future = self._submit_modal_task(
                    self._render_modal_chunk_task,
                    api_base=api_base,
                    prompt_name=prompt_name,
                    prompt_id=resolved_prompt_id,
                    text=chunk_text_value,
                    speed=speed,
                    language=language,
                    max_chars=max_chars,
                    output_root=Path(output_root),
                    variant_index=variant_index,
                    chunk_index=chunk_index,
                    pause_ms=pause_ms,
                    pause_min_ms=pause_min_ms,
                    pause_max_ms=pause_max_ms,
                    render_kwargs=render_kwargs,
                )
                futures[future] = (variant_index, chunk_index)
            if stop_dispatch:
                break

        if stop_dispatch:
            self._cancel_pending_futures(list(futures.keys()))
            return

        pending_futures = set(futures.keys())
        for future in as_completed(list(pending_futures)):
            pending_futures.discard(future)
            if should_cancel and should_cancel():
                self._cancel_pending_futures(list(pending_futures))
                return
            _variant_index, _chunk_index = futures[future]
            try:
                result_variant, result_chunk, chunk_text_value, clip_path = future.result()
            except CancelledError:
                continue
            chunk_paths_by_variant[result_variant][result_chunk] = clip_path
            event = {
                "type": "chunk_done",
                "index": result_chunk,
                "total": chunk_total,
                "text": chunk_text_value,
                "path": str(clip_path),
                "status": "generated",
                "variant": result_variant,
                "variant_total": variant_count,
                "mode": "full_batch",
            }
            candidate = self._build_candidate_from_progress_event(
                session,
                event,
                source_batch_id=source_batch_id,
                variant_label=f"V{result_variant}",
                source_prompt_name=prompt_name,
                source_backend=source_backend,
                source_api_base=api_base,
            )
            if candidate is not None:
                session.add_candidates([candidate])
            if progress_callback:
                progress_callback(event)

            variant_done_counts[result_variant] += 1
            if variant_done_counts[result_variant] == chunk_total:
                self._join_variant_chunks(
                    result_variant,
                    chunk_paths_by_variant[result_variant],
                    chunks,
                    pause_ms,
                    pause_min_ms,
                    pause_max_ms,
                )
                if progress_callback:
                    progress_callback(
                        {
                            "type": "variant_done",
                            "variant": result_variant,
                            "variant_total": variant_count,
                            "mode": "full_batch",
                        }
                    )

    def _render_modal_chunk_task(
        self,
        *,
        api_base: str,
        prompt_name: str,
        prompt_id: str,
        text: str,
        speed: float,
        language: str,
        max_chars: int,
        output_root: Path,
        variant_index: int,
        chunk_index: int,
        pause_ms: int,
        pause_min_ms: int | None,
        pause_max_ms: int | None,
        render_kwargs: dict[str, Any],
    ) -> tuple[int, int, str, Path]:
        temp_output_dir = output_root / "_modal_tasks" / f"variant_{variant_index:02d}" / f"chunk_{chunk_index:03d}"
        temp_output_dir.mkdir(parents=True, exist_ok=True)
        result = self.render_batch_fn(
            text=text,
            api_base=api_base,
            prompt_name=prompt_name,
            prompt_id=prompt_id,
            chunk_mode="line",
            max_chars=max(max_chars, len(text) + 1),
            speed=speed,
            language=language,
            output_dir=temp_output_dir,
            prefix=f"v{variant_index}_chunk_{chunk_index:03d}",
            join_audio=False,
            pause_ms=pause_ms,
            pause_min_ms=pause_min_ms,
            pause_max_ms=pause_max_ms,
            humanize_pause=True,
            progress_callback=lambda _event: None,
            **render_kwargs,
        )
        if not result.clips:
            raise RuntimeError(f"Modal chunk render returned no clips for variant {variant_index}, chunk {chunk_index}")
        raw_clip = result.clips[0].path
        destination_dir = output_root / f"variant_{variant_index:02d}"
        destination_dir.mkdir(parents=True, exist_ok=True)
        destination_path = destination_dir / f"v{variant_index}_chunk_{chunk_index:03d}{raw_clip.suffix.lower()}"
        if raw_clip.resolve() != destination_path.resolve():
            shutil.copyfile(raw_clip, destination_path)
        return variant_index, chunk_index, text, destination_path

    def _join_variant_chunks(
        self,
        variant_index: int,
        chunk_paths: dict[int, Path],
        chunk_texts: list[str],
        pause_ms: int,
        pause_min_ms: int | None,
        pause_max_ms: int | None,
    ) -> None:
        ordered_paths = [chunk_paths[index] for index in range(1, len(chunk_texts) + 1)]
        destination_dir = ordered_paths[0].parent
        joined_wav = destination_dir / "joined.wav"
        try:
            if join_wav_files(
                ordered_paths,
                chunk_texts,
                joined_wav,
                pause_ms,
                True,
                pause_min_ms=pause_min_ms,
                pause_max_ms=pause_max_ms,
            ):
                return
        except Exception:  # noqa: BLE001
            pass
        try:
            joined_fallback = destination_dir / f"joined.{ordered_paths[0].suffix.lower().lstrip('.') or 'wav'}"
            join_with_ffmpeg(ordered_paths, joined_fallback)
        except Exception:  # noqa: BLE001
            pass

    def _run_render_tasks(
        self,
        *,
        tasks: list[tuple[int, dict[str, Any]]],
        source_backend: str | None,
        should_cancel: Callable[[], bool] | None,
    ) -> list[tuple[int, RenderResult]]:
        results: list[tuple[int, RenderResult]] = []
        if source_backend != "modal":
            for task_index, kwargs in tasks:
                if should_cancel and should_cancel():
                    break
                results.append((task_index, self.render_batch_fn(**kwargs)))
            return results

        futures: list[tuple[int, Future[RenderResult]]] = []
        for task_index, kwargs in tasks:
            if should_cancel and should_cancel():
                break
            futures.append((task_index, self._submit_modal_task(self.render_batch_fn, **kwargs)))
        if should_cancel and should_cancel():
            self._cancel_pending_futures([future for _, future in futures])
            return results

        pending_by_task = {task_index: future for task_index, future in futures}
        for task_index, future in futures:
            pending_by_task.pop(task_index, None)
            if should_cancel and should_cancel():
                self._cancel_pending_futures(list(pending_by_task.values()))
                continue
            try:
                results.append((task_index, future.result()))
            except CancelledError:
                continue
        return sorted(results, key=lambda item: item[0])

    def _wrap_progress_callback(
        self,
        *,
        session: StudioSession,
        progress_callback: Callable[[dict], None],
        progress_context: dict[str, Any],
        source_batch_id: str,
        variant_label: str,
        forced_chunk_id: str | None = None,
        source_prompt_name: str | None = None,
        source_backend: str | None = None,
        source_api_base: str | None = None,
    ) -> Callable[[dict[str, Any]], None]:
        def wrapped(event: dict[str, Any]) -> None:
            enriched = {**event, **progress_context}
            if event.get("type") == "chunk_done" and event.get("path"):
                candidate = self._build_candidate_from_progress_event(
                    session,
                    event,
                    source_batch_id=source_batch_id,
                    variant_label=variant_label,
                    forced_chunk_id=forced_chunk_id,
                    source_prompt_name=source_prompt_name,
                    source_backend=source_backend,
                    source_api_base=source_api_base,
                )
                if candidate is not None:
                    session.add_candidates([candidate])
            progress_callback(enriched)

        return wrapped

    def _build_candidate_from_progress_event(
        self,
        session: StudioSession,
        event: dict[str, Any],
        *,
        source_batch_id: str,
        variant_label: str,
        forced_chunk_id: str | None = None,
        source_prompt_name: str | None = None,
        source_backend: str | None = None,
        source_api_base: str | None = None,
    ) -> CandidateRecord | None:
        try:
            raw_path = Path(str(event["path"]))
            clip_index = int(event["index"])
        except (KeyError, TypeError, ValueError):
            return None
        if not raw_path.exists():
            return None
        chunk = session.chunks[clip_index - 1] if forced_chunk_id is None else next(item for item in session.chunks if item.chunk_id == forced_chunk_id)
        normalized_path = raw_path.with_name(f"{raw_path.stem}.normalized.wav")
        resolved_normalized_path = self.normalize_candidate_fn(raw_path, normalized_path)
        return CandidateRecord(
            candidate_id=f"candidate-{uuid.uuid4().hex[:10]}",
            chunk_id=chunk.chunk_id,
            source_batch_id=source_batch_id,
            variant_label=variant_label,
            raw_path=raw_path,
            normalized_wav_path=resolved_normalized_path,
            status=str(event.get("status") or "generated"),
            duration_ms=self._duration_ms(resolved_normalized_path),
            source_prompt_name=source_prompt_name,
            source_backend=source_backend,
            source_api_base=source_api_base,
            created_at=dt.datetime.now(dt.timezone.utc).isoformat(),
        )

    def _build_candidates(
        self,
        session: StudioSession,
        result: RenderResult,
        source_batch_id: str,
        variant_label: str,
        *,
        forced_chunk_id: str | None = None,
        source_prompt_name: str | None = None,
        source_backend: str | None = None,
        source_api_base: str | None = None,
    ) -> list[CandidateRecord]:
        candidates: list[CandidateRecord] = []
        for clip in result.clips:
            chunk = session.chunks[clip.index - 1] if forced_chunk_id is None else next(
                item for item in session.chunks if item.chunk_id == forced_chunk_id
            )
            normalized_path = clip.path.with_name(f"{clip.path.stem}.normalized.wav")
            resolved_normalized_path = self.normalize_candidate_fn(clip.path, normalized_path)
            candidates.append(
                CandidateRecord(
                    candidate_id=f"candidate-{uuid.uuid4().hex[:10]}",
                    chunk_id=chunk.chunk_id,
                    source_batch_id=source_batch_id,
                    variant_label=variant_label,
                    raw_path=clip.path,
                    normalized_wav_path=resolved_normalized_path,
                    status=clip.status,
                    duration_ms=self._duration_ms(resolved_normalized_path),
                    source_prompt_name=source_prompt_name,
                    source_backend=source_backend,
                    source_api_base=source_api_base,
                    created_at=dt.datetime.now(dt.timezone.utc).isoformat(),
                )
            )
        return candidates

    @staticmethod
    def _duration_ms(path: Path) -> int | None:
        try:
            with wave.open(str(path), "rb") as handle:
                frame_rate = handle.getframerate()
                if frame_rate <= 0:
                    return None
                return round(handle.getnframes() / frame_rate * 1000)
        except Exception:  # noqa: BLE001
            return None
