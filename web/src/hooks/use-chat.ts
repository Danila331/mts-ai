"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Channel, patchPassport, streamChat } from "@/lib/api";
import type { PageInfo } from "@/lib/page-context";
import { readSandbox } from "@/lib/sandbox";
import type { ChatMode, Message, Passport, Session, Turn } from "@/lib/types";

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function newSession(): Session {
  const now = Date.now();
  return { id: uid(), title: "Новый диалог", createdAt: now, updatedAt: now, messages: [] };
}

function titleFrom(text: string) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 48 ? `${clean.slice(0, 46)}…` : clean;
}

/** История для API: только завершённые реплики, без отладочных полей. */
export function toTurns(messages: Message[]): Turn[] {
  return messages
    .filter((m) => !m.pending && !m.error && m.content)
    .map((m) => ({ role: m.role, content: m.content }));
}

/**
 * Сессии чата в localStorage + отправка сообщений. Один хук на стенд и на виджет — у них разные ключи хранилища.
 * sandbox — отправлять ли с вопросом настройки песочницы (/settings). Только стенд: виджет на сайте
 * всегда отвечает с общими настройками. channel — откуда разговор: id сессии уходит на сервер с каждым
 * вопросом, и менеджер видит диалог целиком, даже если клиент очистил браузер. page — страница сайта, где
 * открыт виджет (T8): уходит с вопросом и пишется в сессию для аналитики, ядру и в промпт не попадает.
 */
export function useChat(
  storageKey: string,
  mode: ChatMode = "chat",
  { sandbox = false, channel = "playground", page }: { sandbox?: boolean; channel?: Channel; page?: PageInfo } = {},
) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [ready, setReady] = useState(false);
  const controllers = useRef(new Map<string, AbortController>());
  // Поля паспорта, которые ждут конца ответа (мастер T7): см. setWizard.
  const pendingPassport = useRef(new Map<string, Record<string, string>>());

  useEffect(() => {
    let loaded: Session[] = [];
    try {
      loaded = JSON.parse(localStorage.getItem(storageKey) || "[]");
    } catch {
      loaded = [];
    }
    // Незавершённые ответы после перезагрузки страницы уже не придут.
    loaded = loaded.map((s) => ({
      ...s,
      messages: s.messages.map((m) => (m.pending ? { ...m, pending: false, error: "Ответ прерван" } : m)),
    }));
    if (!loaded.length) loaded = [newSession()];
    // eslint-disable-next-line react-hooks/set-state-in-effect -- чтение localStorage возможно только после монтирования
    setSessions(loaded);
    setActiveId(loaded[0].id);
    setReady(true);
  }, [storageKey]);

  useEffect(() => {
    if (ready) localStorage.setItem(storageKey, JSON.stringify(sessions.slice(0, 100)));
  }, [sessions, ready, storageKey]);

  const active = useMemo(() => sessions.find((s) => s.id === activeId) ?? sessions[0], [sessions, activeId]);

  const update = useCallback((id: string, fn: (s: Session) => Session) => {
    setSessions((list) => list.map((s) => (s.id === id ? fn(s) : s)));
  }, []);

  const patchMessage = useCallback(
    (sessionId: string, messageId: string, patch: Partial<Message>) =>
      update(sessionId, (s) => ({
        ...s,
        updatedAt: Date.now(),
        messages: s.messages.map((m) => (m.id === messageId ? { ...m, ...patch } : m)),
      })),
    [update],
  );

  const run = useCallback(
    async (sessionId: string, history: Message[], assistantId: string) => {
      const controller = new AbortController();
      controllers.current.set(sessionId, controller);
      try {
        await streamChat(
          toTurns(history),
          mode,
          {
            onRetrieval: (retrieval) => patchMessage(sessionId, assistantId, { stage: "retrieval", retrieval }),
            onGeneration: () => patchMessage(sessionId, assistantId, { stage: "generation" }),
            onPassport: (passport) => update(sessionId, (s) => ({ ...s, passport })),
            onAnswer: (answer) =>
              patchMessage(sessionId, assistantId, {
                content: answer.text,
                answer,
                retrieval: answer.retrieval,
                pending: false,
                stage: "done",
              }),
          },
          {
            signal: controller.signal,
            // Читаются в момент вопроса: правка на /settings в соседней вкладке действует со следующего ответа.
            overrides: sandbox ? readSandbox() : undefined,
            sessionId,
            channel,
            page,
          },
        );
      } catch (err) {
        const aborted = controller.signal.aborted;
        patchMessage(sessionId, assistantId, {
          pending: false,
          error: aborted ? "Остановлено" : err instanceof Error ? err.message : "Ошибка",
        });
      } finally {
        controllers.current.delete(sessionId);
        const values = pendingPassport.current.get(sessionId);
        if (values) {
          pendingPassport.current.delete(sessionId);
          patchPassport(sessionId, values)
            .then((passport) => update(sessionId, (s) => ({ ...s, passport })))
            // Нет базы на сервере — паспорт не ведётся; ответы мастера всё равно есть в реплике клиента.
            .catch(() => undefined);
        }
      }
    },
    [mode, sandbox, channel, page, patchMessage, update],
  );

  const send = useCallback(
    (text: string) => {
      const content = text.trim();
      if (!content || !active) return;
      const now = Date.now();
      const user: Message = { id: uid(), role: "user", content, createdAt: now };
      const assistant: Message = { id: uid(), role: "assistant", content: "", createdAt: now, pending: true };
      const history = [...active.messages.filter((m) => !m.error), user];
      update(active.id, (s) => ({
        ...s,
        title: s.messages.length ? s.title : titleFrom(content),
        updatedAt: now,
        messages: [...s.messages, user, assistant],
      }));
      void run(active.id, history, assistant.id);
      return assistant.id;
    },
    [active, run, update],
  );

  /** Ответить заново на ту же реплику клиента: ответ и всё после него заменяются. */
  const regenerate = useCallback(
    (messageId: string) => {
      if (!active) return;
      const index = active.messages.findIndex((m) => m.id === messageId);
      if (index < 1) return;
      const history = active.messages.slice(0, index).filter((m) => !m.error);
      const assistant: Message = {
        id: uid(),
        role: "assistant",
        content: "",
        createdAt: Date.now(),
        pending: true,
      };
      update(active.id, (s) => ({ ...s, messages: [...s.messages.slice(0, index), assistant] }));
      void run(active.id, history, assistant.id);
      return assistant.id;
    },
    [active, run, update],
  );

  const stop = useCallback(() => {
    if (active) controllers.current.get(active.id)?.abort();
  }, [active]);

  const create = useCallback(() => {
    // Пустой диалог не плодим: если активный пуст — просто остаёмся в нём.
    if (active && !active.messages.length) return active.id;
    const s = newSession();
    setSessions((list) => [s, ...list]);
    setActiveId(s.id);
    return s.id;
  }, [active]);

  const remove = useCallback(
    (id: string) => {
      controllers.current.get(id)?.abort();
      setSessions((list) => {
        const rest = list.filter((s) => s.id !== id);
        const next = rest.length ? rest : [newSession()];
        if (id === activeId) setActiveId(next[0].id);
        return next;
      });
    },
    [activeId],
  );

  const rename = useCallback((id: string, title: string) => update(id, (s) => ({ ...s, title })), [update]);

  const rate = useCallback(
    (messageId: string, rating: 1 | -1) => active && patchMessage(active.id, messageId, { rating }),
    [active, patchMessage],
  );

  const setLead = useCallback(
    (lead: Session["lead"]) => active && update(active.id, (s) => ({ ...s, lead })),
    [active, update],
  );

  /**
   * Итог мастера (T7) в сессии — свёрнутая карточка в ленте. passport — ответы мастера для паспорта: они уйдут
   * правкой клиента (PATCH), когда закончится следующий ответ. Раньше нельзя: сервер узнаёт о диалоге с первым
   * вопросом, а паспорт по диалогу бот сохраняет до конца потока и мог бы затереть запись, сделанную посреди.
   */
  const setWizard = useCallback(
    (wizard: Session["wizard"], passport: Partial<Record<string, string>> = {}) => {
      if (!active) return;
      const values = Object.fromEntries(Object.entries(passport).filter((e): e is [string, string] => !!e[1]));
      if (Object.keys(values).length) pendingPassport.current.set(active.id, values);
      update(active.id, (s) => ({ ...s, wizard }));
    },
    [active, update],
  );

  /** Клиент поправил паспорт: правка уходит на сервер, бот её больше не перезапишет. */
  const editPassport = useCallback(
    async (values: Record<string, string | null>): Promise<Passport | undefined> => {
      if (!active) return;
      const passport = await patchPassport(active.id, values);
      update(active.id, (s) => ({ ...s, passport }));
      return passport;
    },
    [active, update],
  );

  const busy = !!active?.messages.some((m) => m.pending);

  return {
    ready,
    sessions,
    active,
    activeId: active?.id ?? "",
    select: setActiveId,
    create,
    remove,
    rename,
    send,
    regenerate,
    stop,
    rate,
    setLead,
    setWizard,
    editPassport,
    busy,
  };
}

export type ChatController = ReturnType<typeof useChat>;
