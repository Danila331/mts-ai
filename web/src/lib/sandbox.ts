// Песочница настроек RAG: свои значения посетителя в localStorage этого браузера. Уходят полем overrides
// в /api/chat и действуют только на ответы стенда в этом браузере — общих настроек бота не трогают.
import type { SettingValue } from "./types";

const KEY = "eb.settings.sandbox.v1";

export type Sandbox = Record<string, SettingValue>;

export function readSandbox(): Sandbox {
  if (typeof window === "undefined") return {};
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function writeSandbox(values: Sandbox): void {
  if (Object.keys(values).length) localStorage.setItem(KEY, JSON.stringify(values));
  else localStorage.removeItem(KEY);
}
