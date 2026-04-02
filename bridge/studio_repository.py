#!/usr/bin/env python3
from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any


class StudioRepository:
    def __init__(self, db_path: Path) -> None:
        self.db_path = Path(db_path).expanduser().resolve()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def list_tables(self) -> list[str]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
            ).fetchall()
        return [str(row[0]) for row in rows]

    def upsert_run(self, payload: dict[str, Any]) -> None:
        normalized = {
            "job_id": payload.get("job_id"),
            "run_id": payload.get("run_id"),
            "voice_id": payload.get("voice_id"),
            "voice_display_name": payload.get("voice_display_name"),
            "prompt_name": payload.get("prompt_name"),
            "backend": payload.get("backend"),
            "api_base": payload.get("api_base"),
            "source_text": payload.get("source_text", ""),
            "run_label": payload.get("run_label", ""),
            "status": payload.get("status", "queued"),
            "current_task": payload.get("current_task", "Queued"),
            "progress_percent": payload.get("progress_percent", 0.0),
            "error_message": payload.get("error_message"),
            "created_at": payload.get("created_at"),
            "updated_at": payload.get("updated_at"),
            "run_dir": payload.get("run_dir"),
            "total_generation_time": payload.get("total_generation_time"),
            "preview_mix_path": payload.get("preview_mix_path"),
            "timeline_render_status": payload.get("timeline_render_status"),
            "timeline_render_error": payload.get("timeline_render_error"),
            "timeline_preview_mix_url": payload.get("timeline_preview_mix_url"),
            "timeline_export_path": payload.get("timeline_export_path"),
            "variant_count": payload.get("variant_count"),
            "chunk_mode": payload.get("chunk_mode"),
            "max_chars": payload.get("max_chars"),
            "speed": payload.get("speed"),
            "pause_ms": payload.get("pause_ms"),
            "pause_min_ms": payload.get("pause_min_ms"),
            "pause_max_ms": payload.get("pause_max_ms"),
            "language": payload.get("language"),
        }
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO runs (
                    run_id, job_id, voice_id, voice_display_name, prompt_name, backend, api_base,
                    source_text, run_label, status, current_task, progress_percent, error_message,
                    created_at, updated_at, run_dir, total_generation_time, preview_mix_path,
                    timeline_render_status, timeline_render_error, timeline_preview_mix_url, timeline_export_path,
                    variant_count, chunk_mode, max_chars, speed, pause_ms, pause_min_ms, pause_max_ms, language
                )
                VALUES (
                    :run_id, :job_id, :voice_id, :voice_display_name, :prompt_name, :backend, :api_base,
                    :source_text, :run_label, :status, :current_task, :progress_percent, :error_message,
                    :created_at, :updated_at, :run_dir, :total_generation_time, :preview_mix_path,
                    :timeline_render_status, :timeline_render_error, :timeline_preview_mix_url, :timeline_export_path,
                    :variant_count, :chunk_mode, :max_chars, :speed, :pause_ms, :pause_min_ms, :pause_max_ms, :language
                )
                ON CONFLICT(run_id) DO UPDATE SET
                    job_id = excluded.job_id,
                    voice_id = excluded.voice_id,
                    voice_display_name = excluded.voice_display_name,
                    prompt_name = excluded.prompt_name,
                    backend = excluded.backend,
                    api_base = excluded.api_base,
                    source_text = excluded.source_text,
                    run_label = excluded.run_label,
                    status = excluded.status,
                    current_task = excluded.current_task,
                    progress_percent = excluded.progress_percent,
                    error_message = excluded.error_message,
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at,
                    run_dir = excluded.run_dir,
                    total_generation_time = excluded.total_generation_time,
                    preview_mix_path = excluded.preview_mix_path,
                    timeline_render_status = excluded.timeline_render_status,
                    timeline_render_error = excluded.timeline_render_error,
                    timeline_preview_mix_url = excluded.timeline_preview_mix_url,
                    timeline_export_path = excluded.timeline_export_path,
                    variant_count = excluded.variant_count,
                    chunk_mode = excluded.chunk_mode,
                    max_chars = excluded.max_chars,
                    speed = excluded.speed,
                    pause_ms = excluded.pause_ms,
                    pause_min_ms = excluded.pause_min_ms,
                    pause_max_ms = excluded.pause_max_ms,
                    language = excluded.language
                """,
                normalized,
            )

    def replace_chunks(self, run_id: str, chunks: list[dict[str, Any]]) -> None:
        with self._connect() as connection:
            connection.execute("DELETE FROM chunks WHERE run_id = ?", (run_id,))
            connection.executemany(
                """
                INSERT INTO chunks (
                    chunk_id, run_id, chunk_index, text, status, current_task, generation_time, error_message
                )
                VALUES (
                    :chunk_id, :run_id, :chunk_index, :text, :status, :current_task, :generation_time, :error_message
                )
                """,
                [{**chunk, "run_id": run_id} for chunk in chunks],
            )

    def add_candidates(self, run_id: str, candidates: list[dict[str, Any]]) -> None:
        with self._connect() as connection:
            connection.executemany(
                """
                INSERT OR REPLACE INTO candidates (
                    candidate_id, run_id, chunk_id, source_batch_id, variant_label, status, raw_path,
                    normalized_wav_path, duration_ms, generation_time, source_prompt_name, source_backend,
                    source_api_base, created_at
                )
                VALUES (
                    :candidate_id, :run_id, :chunk_id, :source_batch_id, :variant_label, :status, :raw_path,
                    :normalized_wav_path, :duration_ms, :generation_time, :source_prompt_name, :source_backend,
                    :source_api_base, :created_at
                )
                """,
                [{**candidate, "run_id": run_id} for candidate in candidates],
            )

    def set_chunk_selection(self, chunk_id: str, candidate_id: str) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO chunk_selections (chunk_id, selected_candidate_id, updated_at)
                VALUES (?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(chunk_id) DO UPDATE SET
                    selected_candidate_id = excluded.selected_candidate_id,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (chunk_id, candidate_id),
            )

    def mark_incomplete_runs_interrupted(self) -> int:
        with self._connect() as connection:
            cursor = connection.execute(
                """
                UPDATE runs
                SET status = 'interrupted',
                    current_task = 'Interrupted',
                    updated_at = CURRENT_TIMESTAMP
                WHERE status IN ('queued', 'running', 'canceling')
                """
            )
            return int(cursor.rowcount or 0)

    def load_runs(self, *, limit: int = 100) -> list[dict[str, Any]]:
        with self._connect() as connection:
            run_rows = connection.execute(
                """
                SELECT *
                FROM runs
                ORDER BY created_at DESC, rowid DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
            if not run_rows:
                return []
            run_ids = [str(row["run_id"]) for row in run_rows]
            placeholders = ",".join("?" for _ in run_ids)
            chunk_rows = connection.execute(
                f"""
                SELECT chunks.*, chunk_selections.selected_candidate_id
                FROM chunks
                LEFT JOIN chunk_selections ON chunk_selections.chunk_id = chunks.chunk_id
                WHERE chunks.run_id IN ({placeholders})
                ORDER BY chunks.chunk_index ASC
                """,
                run_ids,
            ).fetchall()
            candidate_rows = connection.execute(
                f"""
                SELECT *
                FROM candidates
                WHERE run_id IN ({placeholders})
                ORDER BY rowid ASC
                """,
                run_ids,
            ).fetchall()

        candidates_by_chunk: dict[str, list[dict[str, Any]]] = {}
        for row in candidate_rows:
            candidates_by_chunk.setdefault(str(row["chunk_id"]), []).append(dict(row))

        chunks_by_run: dict[str, list[dict[str, Any]]] = {}
        for row in chunk_rows:
            chunk_payload = dict(row)
            chunk_payload["candidates"] = candidates_by_chunk.get(str(row["chunk_id"]), [])
            chunks_by_run.setdefault(str(row["run_id"]), []).append(chunk_payload)

        hydrated: list[dict[str, Any]] = []
        for row in run_rows:
            payload = dict(row)
            payload["chunks"] = chunks_by_run.get(str(row["run_id"]), [])
            hydrated.append(payload)
        return hydrated

    def load_run(self, job_id: str) -> dict[str, Any] | None:
        with self._connect() as connection:
            run_row = connection.execute(
                """
                SELECT *
                FROM runs
                WHERE job_id = ?
                """,
                (job_id,),
            ).fetchone()
            if run_row is None:
                return None

            run_id = str(run_row["run_id"])
            chunk_rows = connection.execute(
                """
                SELECT chunks.*, chunk_selections.selected_candidate_id
                FROM chunks
                LEFT JOIN chunk_selections ON chunk_selections.chunk_id = chunks.chunk_id
                WHERE chunks.run_id = ?
                ORDER BY chunks.chunk_index ASC
                """,
                (run_id,),
            ).fetchall()
            candidate_rows = connection.execute(
                """
                SELECT *
                FROM candidates
                WHERE run_id = ?
                ORDER BY rowid ASC
                """,
                (run_id,),
            ).fetchall()

        candidates_by_chunk: dict[str, list[dict[str, Any]]] = {}
        for row in candidate_rows:
            candidates_by_chunk.setdefault(str(row["chunk_id"]), []).append(dict(row))

        chunks: list[dict[str, Any]] = []
        for row in chunk_rows:
            chunk_payload = dict(row)
            chunk_payload["candidates"] = candidates_by_chunk.get(str(row["chunk_id"]), [])
            chunks.append(chunk_payload)

        payload = dict(run_row)
        payload["chunks"] = chunks
        return payload

    def delete_run(self, job_id: str) -> dict[str, Any]:
        with self._connect() as connection:
            row = connection.execute("SELECT run_id, run_dir FROM runs WHERE job_id = ?", (job_id,)).fetchone()
            if row is None:
                return {"deleted": True, "job_id": job_id, "run_dir": None}
            connection.execute("DELETE FROM runs WHERE job_id = ?", (job_id,))
            return {"deleted": True, "job_id": job_id, "run_dir": str(row["run_dir"])}

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                PRAGMA foreign_keys = ON;

                CREATE TABLE IF NOT EXISTS runs (
                    run_id TEXT PRIMARY KEY,
                    job_id TEXT NOT NULL UNIQUE,
                    voice_id TEXT NOT NULL,
                    voice_display_name TEXT NOT NULL,
                    prompt_name TEXT NOT NULL,
                    backend TEXT NOT NULL,
                    api_base TEXT NOT NULL,
                    source_text TEXT NOT NULL,
                    run_label TEXT NOT NULL,
                    status TEXT NOT NULL,
                    current_task TEXT NOT NULL,
                    progress_percent REAL NOT NULL DEFAULT 0,
                    error_message TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    run_dir TEXT NOT NULL,
                    total_generation_time REAL,
                    preview_mix_path TEXT,
                    timeline_render_status TEXT,
                    timeline_render_error TEXT,
                    timeline_preview_mix_url TEXT,
                    timeline_export_path TEXT,
                    variant_count INTEGER,
                    chunk_mode TEXT,
                    max_chars INTEGER,
                    speed REAL,
                    pause_ms INTEGER,
                    pause_min_ms INTEGER,
                    pause_max_ms INTEGER,
                    language TEXT
                );

                CREATE TABLE IF NOT EXISTS chunks (
                    chunk_id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL,
                    chunk_index INTEGER NOT NULL,
                    text TEXT NOT NULL,
                    status TEXT NOT NULL,
                    current_task TEXT NOT NULL,
                    generation_time REAL,
                    error_message TEXT,
                    FOREIGN KEY(run_id) REFERENCES runs(run_id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS candidates (
                    candidate_id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL,
                    chunk_id TEXT NOT NULL,
                    source_batch_id TEXT NOT NULL,
                    variant_label TEXT NOT NULL,
                    status TEXT NOT NULL,
                    raw_path TEXT NOT NULL,
                    normalized_wav_path TEXT NOT NULL,
                    duration_ms INTEGER,
                    generation_time REAL,
                    source_prompt_name TEXT,
                    source_backend TEXT,
                    source_api_base TEXT,
                    created_at TEXT,
                    FOREIGN KEY(run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
                    FOREIGN KEY(chunk_id) REFERENCES chunks(chunk_id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS chunk_selections (
                    chunk_id TEXT PRIMARY KEY,
                    selected_candidate_id TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(chunk_id) REFERENCES chunks(chunk_id) ON DELETE CASCADE,
                    FOREIGN KEY(selected_candidate_id) REFERENCES candidates(candidate_id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS run_assets (
                    asset_id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    path TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(run_id) REFERENCES runs(run_id) ON DELETE CASCADE
                );
                """
            )
            self._ensure_run_column(connection, "variant_count", "INTEGER")
            self._ensure_run_column(connection, "chunk_mode", "TEXT")
            self._ensure_run_column(connection, "max_chars", "INTEGER")
            self._ensure_run_column(connection, "speed", "REAL")
            self._ensure_run_column(connection, "pause_ms", "INTEGER")
            self._ensure_run_column(connection, "pause_min_ms", "INTEGER")
            self._ensure_run_column(connection, "pause_max_ms", "INTEGER")
            self._ensure_run_column(connection, "language", "TEXT")

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    @staticmethod
    def _ensure_run_column(connection: sqlite3.Connection, name: str, definition: str) -> None:
        columns = {str(row["name"]) for row in connection.execute("PRAGMA table_info(runs)").fetchall()}
        if name not in columns:
            connection.execute(f"ALTER TABLE runs ADD COLUMN {name} {definition}")
