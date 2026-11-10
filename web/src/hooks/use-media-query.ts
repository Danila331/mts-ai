"use client";

import { useSyncExternalStore } from "react";

/** Совпадает ли медиазапрос; на сервере — значение по умолчанию. */
export function useMediaQuery(query: string, serverDefault = false) {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => serverDefault,
  );
}
