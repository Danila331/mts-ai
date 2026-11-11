"""FastAPI-приложение веб-чата: сессии, ходы через ядро energybot, заявки, отладка.

Переходы состояний и запись заявок контролирует код (без LangGraph): один ход
в сессии за раз, request_id делает повтор HTTP-запроса идемпотентным, вызов
модели идёт вне транзакции SQLite.

Запуск: uvicorn webapp.app:app --host 0.0.0.0 --port 8000
Переменные: KB_PATH (по умолчанию knowledge-base/), WEBAPP_DB (по умолчанию webapp.sqlite3).
"""

from __future__ import annotations

import json
import re
import threading
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel, Field

from energybot.llm import Api, env, env_num
from energybot.pipeline import Consultant

from .db import Store

ROOT = Path(__file__).resolve().parents[1]
STATIC = Path(__file__).resolve().parent / "static"

SUMMARY_PROMPT = """Составь краткое резюме диалога клиента с ИИ-консультантом МТС EnergyTool для менеджера.
Структура: задача клиента; тип объекта и подтверждённые параметры (только то, что клиент назвал сам);
обсуждённые решения EnergyTool; открытые вопросы. 3–6 коротких строк, без выдуманных фактов,
без контактов (они передаются отдельно). Обычный текст, без markdown.

ДИАЛОГ:
{dialog}"""

PHONE = re.compile(r"^[+0-9][\d\s()\-]{6,20}$")


def is_boundary(text: str, error: str) -> bool:
    """Исход хода для веба: граница/сбой определяем по тексту, без поля в ядре."""
    if error:
        return True
    t = text.lower()
    return "в моих материалах нет" in t or "специалист" in t


class ChatIn(BaseModel):
    session_id: str
    request_id: str = Field(min_length=4, max_length=64)
    message: str = Field(min_length=1, max_length=4000)


class LeadIn(BaseModel):
    session_id: str
    request_id: str = Field(min_length=4, max_length=64)
    name: str = Field(min_length=2, max_length=120)
    phone: str = Field(min_length=7, max_length=24)
    company: str = Field(min_length=2, max_length=200)


def make_summary(api: Api, turns: list) -> tuple[str, str]:
    """Резюме менеджеру из фактов диалога. При сбое модели — выжимка известных полей,
    чтобы заявка сохранилась, а отсутствие модельного резюме было видно."""
    dialog = "\n".join(f"{'Клиент' if t['role'] == 'user' else 'Консультант'}: {t['content']}" for t in turns)
    if api.configured and dialog.strip():
        try:
            text = api.chat([{"role": "user", "content": SUMMARY_PROMPT.format(dialog=dialog[:8000])}],
                            max_tokens=400)
            if text.strip():
                return " ".join(text.split()), ""
        except Exception as exc:  # noqa: BLE001
            return _fallback_summary(turns), f"резюме без модели: {type(exc).__name__}"
    return _fallback_summary(turns), "резюме без модели" if not api.configured else ""


def _fallback_summary(turns: list) -> str:
    users = [t["content"] for t in turns if t["role"] == "user"]
    if not users:
        return "Диалог пуст."
    out = [f"Задача клиента: {users[0]}"]
    if len(users) > 1:
        out.append("Уточнения клиента: " + " | ".join(users[1:4]))
    return "\n".join(out)


def create_app(consultant: Consultant, store: Store) -> FastAPI:
    app = FastAPI(title="МТС EnergyTool — ИИ-консультант")
    session_locks: dict[str, threading.Lock] = {}
    locks_guard = threading.Lock()

    def lock_for(sid: str) -> threading.Lock:
        with locks_guard:
            return session_locks.setdefault(sid, threading.Lock())

    def turn_view(t) -> dict:
        timings = json.loads(t["timings"]) if isinstance(t["timings"], str) else t["timings"]
        sources = json.loads(t["sources"]) if isinstance(t["sources"], str) else t["sources"]
        return {"text": t["bot"], "action": t["action"], "sources": sources,
                "timings_ms": {k: round(v * 1000) for k, v in timings.items()},
                "error": t["error"], "status": t["status"], "request_id": t["request_id"]}

    # ---------- страницы ----------
    @app.get("/", response_class=HTMLResponse)
    def index():
        return FileResponse(STATIC / "chat.html")

    @app.get("/debug", response_class=HTMLResponse)
    def debug_page():
        return FileResponse(STATIC / "debug.html")

    # ---------- сессии ----------
    @app.post("/api/session")
    def new_session():
        return {"session_id": store.new_session()}

    @app.post("/api/session/{sid}/close")
    def close_session(sid: str):
        if not store.get_session(sid):
            raise HTTPException(404, "сессия не найдена")
        store.close_session(sid)
        return {"ok": True}

    @app.get("/api/history/{sid}")
    def history(sid: str):
        if not store.get_session(sid):
            raise HTTPException(404, "сессия не найдена")
        turns = [t for t in store.turns_full(sid) if t["status"] == "done"]
        return {"session_id": sid,
                "turns": [{"user": t["user"], "bot": t["bot"], "action": t["action"]} for t in turns]}

    # ---------- ход ----------
    @app.post("/api/chat")
    def chat(body: ChatIn):
        session = store.get_session(body.session_id)
        if not session:
            raise HTTPException(404, "сессия не найдена")
        if session["closed"]:
            raise HTTPException(409, "сессия закрыта: начните новый диалог")
        # Идемпотентность: повтор HTTP-запроса с тем же request_id возвращает сохранённый ответ.
        existing = store.find_turn(body.session_id, body.request_id)
        if existing:
            if existing["status"] == "done":
                return turn_view(existing)
            if existing["status"] == "pending":
                raise HTTPException(409, "ход уже обрабатывается")
            # interrupted/error — разрешаем повтор с тем же request_id: пересоздаём строку
            store.delete_turn(existing["id"])
        lock = lock_for(body.session_id)
        if not lock.acquire(blocking=False):
            raise HTTPException(409, "дождитесь ответа на предыдущую реплику")
        try:
            history = store.history(body.session_id)
            turn_id = store.begin_turn(body.session_id, body.request_id, body.message)
            try:
                result = consultant.answer(history + [{"role": "user", "content": body.message}], mode="chat")
            except Exception as exc:  # noqa: BLE001 — ход не должен ронять сессию
                store.fail_turn(turn_id, f"{type(exc).__name__}: {exc}")
                raise HTTPException(503, "модель временно недоступна, повторите реплику")
            # Сбой модели — отдельный исход: в историю не пишем, клиенту — понятный статус,
            # повтор с тем же request_id разрешён (строка со статусом error пересоздаётся).
            if result.error:
                store.fail_turn(turn_id, result.error)
                raise HTTPException(503, "модель временно недоступна, повторите реплику")
            store.finish_turn(turn_id, result)
            # Handoff после двух подряд границ/передач специалисту (паттерн rag-support-bot):
            # не выдумываем дальше, предлагаем человека.
            suggest_lead = False
            if is_boundary(result.text, result.error):
                recent = [t for t in store.turns_full(body.session_id) if t["status"] == "done"][-2:]
                if len(recent) == 2 and all(is_boundary(t["bot"], t["error"]) for t in recent):
                    suggest_lead = True
            return {"text": result.text, "sources": result.sources,
                    "used_sources": result.used_sources, "suggest_lead": suggest_lead,
                    "timings_ms": {k: round(v * 1000) for k, v in result.timings.items()},
                    "error": result.error, "status": "done", "request_id": body.request_id}
        finally:
            lock.release()

    # ---------- заявка ----------
    @app.post("/api/lead")
    def lead(body: LeadIn):
        session = store.get_session(body.session_id)
        if not session:
            raise HTTPException(404, "сессия не найдена")
        if not PHONE.match(body.phone.strip()):
            raise HTTPException(422, "проверьте номер телефона")
        # Повторная отправка формы с тем же request_id возвращает существующую заявку.
        existing = store.find_lead(body.request_id)
        if existing:
            return {"lead_id": existing["id"], "duplicated": True}
        if store.session_has_lead(body.session_id):
            raise HTTPException(409, "заявка по этому диалогу уже сохранена")
        turns = store.history(body.session_id)
        summary, note = make_summary(consultant.api, turns)
        lead_id = store.add_lead(body.session_id, body.request_id, body.name.strip(),
                                 body.phone.strip(), body.company.strip(), summary)
        return {"lead_id": lead_id, "duplicated": False, "summary": summary, "note": note}

    # ---------- экран проверки ----------
    @app.get("/api/debug/overview")
    def debug_overview():
        return store.overview()

    return app


def build() -> FastAPI:
    """Фабрика приложения: uvicorn --factory webapp.app:build или python -m webapp.app."""
    kb_path = Path(env("KB_PATH", str(ROOT / "knowledge-base")))
    db_path = env("WEBAPP_DB", str(ROOT / "webapp.sqlite3"))
    consultant = Consultant(kb_path)
    store = Store(db_path)
    return create_app(consultant, store)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("webapp.app:build", factory=True, host="0.0.0.0", port=env_num("PORT", 8000, 1, 65535))
