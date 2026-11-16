"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Диктовка в поле ввода через Web Speech API браузера. Звук обрабатывает сам браузер — на наш сервер он не
// уходит, а распознанный текст только подставляется в поле: клиент проверяет и отправляет его сам.
// Типов Web Speech API нет в lib.dom TypeScript, поэтому — минимальное описание того, что используем.
interface Alternative {
  transcript: string;
}
interface Result {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: Alternative;
}
interface ResultEvent {
  readonly resultIndex: number;
  readonly results: { readonly length: number; [index: number]: Result };
}
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: ResultEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Понятный текст ошибки распознавания: что сделать клиенту. */
export function dictationError(code: string): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Нет доступа к микрофону — разрешите его в настройках браузера";
    case "audio-capture":
      return "Микрофон не найден";
    case "network":
      return "Распознавание речи недоступно без сети";
    case "no-speech":
      return "Не расслышал — попробуйте ещё раз";
    default:
      return "Не удалось распознать речь";
  }
}

/**
 * onText получает распознанную фразу целиком, когда браузер её закончил. supported — есть ли API
 * (известно только после монтирования: на сервере window нет).
 */
export function useDictation(onText: (text: string) => void, onError?: (message: string) => void) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const rec = useRef<Recognition | null>(null);
  const handlers = useRef({ onText, onError });

  useEffect(() => {
    handlers.current = { onText, onError };
  }, [onText, onError]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- API браузера видно только после монтирования
    setSupported(recognitionCtor() !== null);
    return () => rec.current?.abort();
  }, []);

  const stop = useCallback(() => rec.current?.stop(), []);

  const start = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor || rec.current) return;
    const r = new Ctor();
    r.lang = "ru-RU";
    r.interimResults = false;
    r.continuous = false;
    r.onresult = (e) => {
      let text = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) text += e.results[i][0]?.transcript ?? "";
      }
      if (text.trim()) handlers.current.onText(text.trim());
    };
    r.onerror = (e) => {
      if (e.error !== "aborted") handlers.current.onError?.(dictationError(e.error));
    };
    r.onend = () => {
      rec.current = null;
      setListening(false);
    };
    rec.current = r;
    setListening(true);
    try {
      r.start();
    } catch {
      rec.current = null;
      setListening(false);
      handlers.current.onError?.(dictationError(""));
    }
  }, []);

  const toggle = useCallback(() => (rec.current ? stop() : start()), [start, stop]);

  return { supported, listening, toggle };
}
