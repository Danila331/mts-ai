"""SQLite-хранилище веб-прототипа: сессии, ходы, заявки.

Один процесс, одно соединение, короткие транзакции. Сетевой вызов модели идёт
вне транзакции: строка хода создаётся со статусом pending, а результат и состояние
записываются одной короткой транзакцией. При старте незавершённые ходы помечаются
прерванными, и повтор с тем же request_id разрешён.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    created_at REAL NOT NULL,
    closed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    user TEXT NOT NULL,
    bot TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL DEFAULT '',
    sources TEXT NOT NULL DEFAULT '[]',
    timings TEXT NOT NULL DEFAULT '{}',
    guard TEXT NOT NULL DEFAULT '{}',
    error TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at REAL NOT NULL,
    UNIQUE (session_id, request_id)
);
CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    request_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    company TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at REAL NOT NULL
);
"""


class Store:
    def __init__(self, path: str | Path):
        self.db = sqlite3.connect(str(path), check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.Lock()
        with self.lock:
            self.db.executescript(SCHEMA)
            # Восстановление после падения процесса: pending → interrupted.
            self.db.execute("UPDATE turns SET status='interrupted' WHERE status='pending'")
            self.db.commit()

    def close(self):
        with self.lock:
            self.db.close()

    # ---------- сессии ----------
    def new_session(self) -> str:
        sid = uuid.uuid4().hex[:12]
        with self.lock:
            self.db.execute("INSERT INTO sessions (id, created_at) VALUES (?, ?)", (sid, time.time()))
            self.db.commit()
        return sid

    def get_session(self, sid: str):
        with self.lock:
            return self.db.execute("SELECT * FROM sessions WHERE id=?", (sid,)).fetchone()

    def close_session(self, sid: str):
        with self.lock:
            self.db.execute("UPDATE sessions SET closed=1 WHERE id=?", (sid,))
            self.db.commit()

    # ---------- ходы ----------
    def find_turn(self, sid: str, request_id: str):
        with self.lock:
            return self.db.execute(
                "SELECT * FROM turns WHERE session_id=? AND request_id=?", (sid, request_id)).fetchone()

    def begin_turn(self, sid: str, request_id: str, user: str):
        with self.lock:
            cur = self.db.execute(
                "INSERT INTO turns (session_id, request_id, user, created_at) VALUES (?, ?, ?, ?)",
                (sid, request_id, user, time.time()))
            self.db.commit()
            return cur.lastrowid

    def finish_turn(self, turn_id: int, result):
        """Результат хода и диагностика — одной короткой транзакцией."""
        with self.lock:
            self.db.execute(
                "UPDATE turns SET bot=?, action=?, sources=?, timings=?, guard=?, error=?, status='done' "
                "WHERE id=?",
                (result.text, result.action, json.dumps(result.sources, ensure_ascii=False),
                 json.dumps(result.timings), json.dumps(result.guard, ensure_ascii=False),
                 result.error, turn_id))
            self.db.commit()

    def fail_turn(self, turn_id: int, error: str):
        with self.lock:
            self.db.execute("UPDATE turns SET status='error', error=? WHERE id=?", (error, turn_id))
            self.db.commit()

    def delete_turn(self, turn_id: int):
        """Прерванный или ошибочный ход: повтор с тем же request_id пересоздаёт строку."""
        with self.lock:
            self.db.execute("DELETE FROM turns WHERE id=?", (turn_id,))
            self.db.commit()

    def history(self, sid: str) -> list:
        """Готовые ходы сессии в порядке диалога: [{'role': ..., 'content': ...}, ...] для ядра."""
        with self.lock:
            rows = self.db.execute(
                "SELECT user, bot FROM turns WHERE session_id=? AND status='done' ORDER BY id", (sid,)).fetchall()
        turns = []
        for r in rows:
            turns.append({"role": "user", "content": r["user"]})
            if r["bot"]:
                turns.append({"role": "assistant", "content": r["bot"]})
        return turns

    def turns_full(self, sid: str) -> list:
        with self.lock:
            rows = self.db.execute("SELECT * FROM turns WHERE session_id=? ORDER BY id", (sid,)).fetchall()
        return [dict(r) for r in rows]

    # ---------- заявки ----------
    def find_lead(self, request_id: str):
        with self.lock:
            return self.db.execute("SELECT * FROM leads WHERE request_id=?", (request_id,)).fetchone()

    def add_lead(self, sid: str, request_id: str, name: str, phone: str, company: str, summary: str) -> int:
        with self.lock:
            cur = self.db.execute(
                "INSERT INTO leads (session_id, request_id, name, phone, company, summary, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (sid, request_id, name, phone, company, summary, time.time()))
            self.db.commit()
            return cur.lastrowid

    def session_has_lead(self, sid: str) -> bool:
        with self.lock:
            return self.db.execute("SELECT 1 FROM leads WHERE session_id=? LIMIT 1", (sid,)).fetchone() is not None

    # ---------- экран проверки ----------
    def overview(self) -> dict:
        with self.lock:
            sessions = [dict(r) for r in self.db.execute("SELECT * FROM sessions ORDER BY created_at DESC")]
            leads = [dict(r) for r in self.db.execute("SELECT * FROM leads ORDER BY id DESC")]
        for s in sessions:
            s["turns"] = self.turns_full(s["id"])
            for t in s["turns"]:
                t["sources"] = json.loads(t["sources"])
                t["timings"] = json.loads(t["timings"])
                t["guard"] = json.loads(t["guard"])
        return {"sessions": sessions, "leads": leads}
