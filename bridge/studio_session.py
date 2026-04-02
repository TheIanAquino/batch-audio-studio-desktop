#!/usr/bin/env python3
from __future__ import annotations

import threading
import uuid
from dataclasses import dataclass, field
from pathlib import Path
import re


@dataclass
class CandidateRecord:
    candidate_id: str
    chunk_id: str
    source_batch_id: str
    variant_label: str
    raw_path: Path
    normalized_wav_path: Path
    status: str
    generation_time: float | None = None
    duration_ms: int | None = None
    source_prompt_name: str | None = None
    source_backend: str | None = None
    source_api_base: str | None = None
    created_at: str | None = None


@dataclass
class ChunkRecord:
    chunk_id: str
    index: int
    text: str
    candidates: list[CandidateRecord] = field(default_factory=list)
    status: str = "queued"
    generation_time: float | None = None
    current_task: str = "Queued"
    error_message: str | None = None


@dataclass
class StudioSession:
    source_text: str = ""
    chunks: list[ChunkRecord] = field(default_factory=list)
    selections: dict[str, str] = field(default_factory=dict)
    _lock: threading.RLock = field(default_factory=threading.RLock, init=False, repr=False, compare=False)

    def set_chunks(self, chunk_texts: list[str], source_text: str = "") -> None:
        with self._lock:
            self.source_text = source_text
            self.selections = {}
            self.chunks = [
                ChunkRecord(chunk_id=f"chunk-{index:03d}-{uuid.uuid4().hex[:8]}", index=index, text=text, status="queued")
                for index, text in enumerate(chunk_texts, start=1)
            ]

    def update_chunk_text(self, chunk_id: str, new_text: str) -> None:
        normalized = new_text.strip()
        with self._lock:
            for chunk in self.chunks:
                if chunk.chunk_id == chunk_id:
                    chunk.text = normalized
                    self._refresh_source_text()
                    return
        raise KeyError(chunk_id)

    def insert_chunk(self, text: str, *, after_chunk_id: str | None = None) -> ChunkRecord:
        normalized = text.strip()
        if not normalized:
            raise ValueError("Chunk text cannot be empty.")
        with self._lock:
            insert_at = len(self.chunks)
            if after_chunk_id:
                for index, chunk in enumerate(self.chunks):
                    if chunk.chunk_id == after_chunk_id:
                        insert_at = index + 1
                        break
                else:
                    raise KeyError(after_chunk_id)
            new_chunk = ChunkRecord(
                chunk_id=f"chunk-{uuid.uuid4().hex[:12]}",
                index=insert_at + 1,
                text=normalized,
                status="queued",
                current_task="Queued",
                error_message=None,
            )
            self.chunks.insert(insert_at, new_chunk)
            self._reindex_chunks()
            self._refresh_source_text()
            return new_chunk

    def move_chunk(self, chunk_id: str, to_index: int) -> None:
        with self._lock:
            for current_index, chunk in enumerate(self.chunks):
                if chunk.chunk_id != chunk_id:
                    continue
                moved = self.chunks.pop(current_index)
                bounded_index = max(0, min(len(self.chunks), int(to_index)))
                self.chunks.insert(bounded_index, moved)
                self._reindex_chunks()
                self._refresh_source_text()
                return
        raise KeyError(chunk_id)

    def delete_chunk(self, chunk_id: str) -> ChunkRecord:
        with self._lock:
            for index, chunk in enumerate(self.chunks):
                if chunk.chunk_id != chunk_id:
                    continue
                removed = self.chunks.pop(index)
                self.selections.pop(chunk_id, None)
                self._reindex_chunks()
                self._refresh_source_text()
                return removed
        raise KeyError(chunk_id)

    def delete_candidate(self, chunk_id: str, candidate_id: str) -> CandidateRecord:
        with self._lock:
            chunk = self.get_chunk(chunk_id)
            for index, candidate in enumerate(chunk.candidates):
                if candidate.candidate_id != candidate_id:
                    continue
                removed = chunk.candidates.pop(index)
                selected = self.selections.get(chunk_id)
                if selected == candidate_id:
                    self.selections.pop(chunk_id, None)
                    if chunk.candidates:
                        self.selections[chunk_id] = chunk.candidates[0].candidate_id
                if not chunk.candidates:
                    chunk.status = "queued"
                    chunk.current_task = "Queued"
                    chunk.error_message = None
                return removed
        raise KeyError(candidate_id)

    def add_candidates(self, candidates: list[CandidateRecord]) -> None:
        with self._lock:
            chunk_lookup = {chunk.chunk_id: chunk for chunk in self.chunks}
            for candidate in candidates:
                chunk = chunk_lookup[candidate.chunk_id]
                if any(existing.raw_path == candidate.raw_path and existing.variant_label == candidate.variant_label for existing in chunk.candidates):
                    continue
                chunk.candidates.append(candidate)
                chunk.candidates.sort(key=lambda item: _variant_sort_key(item.variant_label))
                chunk.status = "completed"
                chunk.error_message = None
                if candidate.generation_time is not None:
                    chunk.generation_time = candidate.generation_time

    def get_chunk(self, chunk_id: str) -> ChunkRecord:
        with self._lock:
            for chunk in self.chunks:
                if chunk.chunk_id == chunk_id:
                    return chunk
        raise KeyError(chunk_id)

    def set_chunk_status(
        self,
        chunk_id: str,
        *,
        status: str | None = None,
        current_task: str | None = None,
        generation_time: float | None = None,
        error_message: str | None = None,
    ) -> None:
        with self._lock:
            chunk = self.get_chunk(chunk_id)
            if status is not None:
                chunk.status = status
            if current_task is not None:
                chunk.current_task = current_task
            if generation_time is not None:
                chunk.generation_time = generation_time
            chunk.error_message = error_message

    def chunk_candidates(self, chunk_id: str) -> list[CandidateRecord]:
        with self._lock:
            for chunk in self.chunks:
                if chunk.chunk_id == chunk_id:
                    return chunk.candidates
        raise KeyError(chunk_id)

    def select_candidate(self, chunk_id: str, candidate_id: str) -> None:
        with self._lock:
            candidates = self.chunk_candidates(chunk_id)
            if not any(candidate.candidate_id == candidate_id for candidate in candidates):
                raise KeyError(candidate_id)
            self.selections[chunk_id] = candidate_id

    def selected_candidate(self, chunk_id: str) -> CandidateRecord:
        with self._lock:
            selected_id = self.selections[chunk_id]
            for candidate in self.chunk_candidates(chunk_id):
                if candidate.candidate_id == selected_id:
                    return candidate
        raise KeyError(selected_id)

    def selected_candidates(self) -> list[CandidateRecord]:
        with self._lock:
            return [self.selected_candidate(chunk.chunk_id) for chunk in self.chunks if chunk.chunk_id in self.selections]

    def _reindex_chunks(self) -> None:
        for index, chunk in enumerate(self.chunks, start=1):
            chunk.index = index

    def _refresh_source_text(self) -> None:
        self.source_text = "\n\n".join(item.text for item in self.chunks if item.text.strip())

    @classmethod
    def from_persisted(
        cls,
        *,
        source_text: str,
        chunks: list[dict[str, object]],
    ) -> StudioSession:
        session = cls(source_text=source_text)
        session.chunks = []
        session.selections = {}
        for chunk_payload in chunks:
            chunk = ChunkRecord(
                chunk_id=str(chunk_payload["chunk_id"]),
                index=int(chunk_payload["chunk_index"]),
                text=str(chunk_payload["text"]),
                candidates=[],
                status=str(chunk_payload.get("status") or "queued"),
                generation_time=None if chunk_payload.get("generation_time") is None else float(chunk_payload["generation_time"]),
                current_task=str(chunk_payload.get("current_task") or "Queued"),
                error_message=None if chunk_payload.get("error_message") is None else str(chunk_payload["error_message"]),
            )
            for candidate_payload in chunk_payload.get("candidates", []):
                chunk.candidates.append(
                    CandidateRecord(
                        candidate_id=str(candidate_payload["candidate_id"]),
                        chunk_id=str(candidate_payload["chunk_id"]),
                        source_batch_id=str(candidate_payload["source_batch_id"]),
                        variant_label=str(candidate_payload["variant_label"]),
                        raw_path=Path(str(candidate_payload["raw_path"])),
                        normalized_wav_path=Path(str(candidate_payload["normalized_wav_path"])),
                        status=str(candidate_payload["status"]),
                        generation_time=None if candidate_payload.get("generation_time") is None else float(candidate_payload["generation_time"]),
                        duration_ms=None if candidate_payload.get("duration_ms") is None else int(candidate_payload["duration_ms"]),
                        source_prompt_name=None if candidate_payload.get("source_prompt_name") is None else str(candidate_payload["source_prompt_name"]),
                        source_backend=None if candidate_payload.get("source_backend") is None else str(candidate_payload["source_backend"]),
                        source_api_base=None if candidate_payload.get("source_api_base") is None else str(candidate_payload["source_api_base"]),
                        created_at=None if candidate_payload.get("created_at") is None else str(candidate_payload["created_at"]),
                    )
                )
            session.chunks.append(chunk)
            selected_candidate_id = chunk_payload.get("selected_candidate_id")
            if selected_candidate_id:
                session.selections[chunk.chunk_id] = str(selected_candidate_id)
        return session


def _variant_sort_key(label: str) -> tuple[str, int, str]:
    value = str(label or "")
    match = re.match(r"^([A-Za-z]+)(\d+)$", value)
    if not match:
        return ("zz", 0, value)
    prefix = match.group(1)
    prefix_order = {
        "V": "aa",
        "R": "ab",
    }
    return (prefix_order.get(prefix, prefix.lower()), int(match.group(2)), value)
