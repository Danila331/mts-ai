"use client";

import { useEffect, useRef, useState } from "react";
import { HONEYPOT_FIELD, HONEYPOT_STYLE, elapsedMs, remainingMs } from "@/lib/antibot";

/**
 * Антибот формы заявки без CAPTCHA (T35): скрытая ловушка и время заполнения.
 *
 * `field` — невидимое для человека поле, его кладут внутрь формы. `settle()` перед отправкой дожидается порога
 * (если форма предзаполнена и человек нажал «Отправить» за долю секунды, он просто подождёт — без ошибок и
 * упрёков) и возвращает поля для сервера: `website` и `elapsed_ms`.
 */
export function useAntibot() {
  const shownAt = useRef(0);
  const [trap, setTrap] = useState("");
  const trapRef = useRef("");

  useEffect(() => {
    shownAt.current = Date.now();
  }, []);

  const field = (
    <div aria-hidden="true" inert style={HONEYPOT_STYLE}>
      <label htmlFor={`hp-${HONEYPOT_FIELD}`} aria-hidden="true">Сайт компании (оставьте пустым)</label>
      <input
        id={`hp-${HONEYPOT_FIELD}`}
        name={HONEYPOT_FIELD}
        type="text"
        value={trap}
        onChange={(e) => {
          trapRef.current = e.target.value;
          setTrap(e.target.value);
        }}
        tabIndex={-1}
        aria-hidden="true"
        autoComplete="off"
        data-lpignore="true"
        data-1p-ignore="true"
      />
    </div>
  );

  const settle = async (): Promise<{ website: string; elapsed_ms: number }> => {
    const wait = remainingMs(shownAt.current, Date.now());
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    return { website: trapRef.current, elapsed_ms: elapsedMs(shownAt.current, Date.now()) };
  };

  return { field, settle };
}
