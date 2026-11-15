/**
 * Страница сайта, на которой открыт виджет (T8), и тема этой страницы.
 *
 * Чистый модуль без импортов: его собирают и загрузчик виджета (widget/loader.ts → public/widget.js),
 * и /embed, а тесты запускает `node --test` без сборки. Пределы — те же, что проверяет Go-API
 * (backend/internal/session: ParsePage): иначе сервер ответит 400.
 */

/** UTM-метки, которые виджет берёт из адреса страницы. Остальные параметры адреса не передаются. */
export const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;

export type UtmKey = (typeof UTM_KEYS)[number];

/** Только эти поля: путь, заголовок, UTM. Без cookies, полного адреса и referrer. */
export type PageInfo = Partial<Record<"path" | "title" | UtmKey, string>>;

/** Порядок важности: если объект не влезает в предел, отбрасываются поля с конца. */
const PAGE_KEYS = ["path", "utm_source", "utm_medium", "utm_campaign", "title", "utm_term", "utm_content"] as const;

/** Предел одного значения, в знаках (сервер: PageValueRunes). */
export const PAGE_VALUE_MAX = 300;
/** Предел объекта в байтах JSON (сервер: PageBytes = 2048) — с запасом. */
export const PAGE_MAX_BYTES = 2000;

const utf8Length = (s: string) => new TextEncoder().encode(s).length;

/** Обрезает строку до max знаков (кодовых точек, как считает сервер). */
function clip(value: string, max: number) {
  const chars = Array.from(value.replace(/\s+/g, " ").trim());
  return chars.length > max ? chars.slice(0, max).join("") : chars.join("");
}

/**
 * Приводит что угодно к PageInfo: только известные ключи, только непустые строки до PAGE_VALUE_MAX знаков,
 * весь объект — не больше PAGE_MAX_BYTES. Нужен с обеих сторон: загрузчик собирает страницу, /embed не верит
 * тому, что пришло через postMessage.
 */
export function sanitizePage(raw: unknown): PageInfo {
  const page: PageInfo = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return page;
  const src = raw as Record<string, unknown>;
  for (const key of PAGE_KEYS) {
    const value = src[key];
    if (typeof value !== "string") continue;
    const clean = clip(value, PAGE_VALUE_MAX);
    if (!clean) continue;
    const next = { ...page, [key]: clean };
    if (utf8Length(JSON.stringify(next)) > PAGE_MAX_BYTES) continue;
    page[key] = clean;
  }
  return page;
}

/** Страница по частям адреса: путь, заголовок и UTM из строки запроса. Остальные параметры отбрасываются. */
export function pageFrom(pathname: string, title: string, search: string): PageInfo {
  const params = new URLSearchParams(search);
  const raw: Record<string, string> = { path: pathname, title };
  for (const key of UTM_KEYS) {
    const value = params.get(key);
    if (value) raw[key] = value;
  }
  return sanitizePage(raw);
}

/** Имя темы: латиница, цифры, «-». Что с ним показать, решает /embed (src/components/chat/topics.ts). */
const TOPIC = /^[a-z0-9-]{1,32}$/;
export const isTopicName = (v: unknown): v is string => typeof v === "string" && TOPIC.test(v);

/** Префикс пути: начинается с «/», без пробелов, кавычек и угловых скобок. */
const PREFIX = /^\/[^\s"'<>]{0,199}$/;
const MAX_TOPICS = 50;

/**
 * Разбирает атрибут data-topics='{"/solar":"solar","/askue":"askue"}': префикс пути → тема.
 * Неверный JSON, неверные префиксы и имена тем молча пропускаются — виджет работает с темой по умолчанию.
 */
export function parseTopics(attr: string | null | undefined): Record<string, string> {
  if (!attr) return {};
  let data: unknown;
  try {
    data = JSON.parse(attr);
  } catch {
    return {};
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const out: Record<string, string> = {};
  for (const [prefix, topic] of Object.entries(data).slice(0, MAX_TOPICS)) {
    if (PREFIX.test(prefix) && isTopicName(topic)) out[normalizePath(prefix)] = topic;
  }
  return out;
}

/** Путь для сравнения: раскодированный, в нижнем регистре, без завершающего «/» (кроме корня). */
function normalizePath(path: string) {
  let p = path;
  try {
    p = decodeURIComponent(path);
  } catch {
    // Битая %-последовательность — сравниваем как есть.
  }
  p = p.toLowerCase();
  return p.length > 1 ? p.replace(/\/+$/, "") || "/" : p;
}

/**
 * Тема страницы: самый длинный префикс, совпавший с путём по границе сегмента.
 * "/solar" подходит к "/solar", "/solar/", "/solar/roof", но не к "/solarium". "/" — тема для всего сайта.
 */
export function matchTopic(pathname: string, topics: Record<string, string>): string | undefined {
  const path = normalizePath(pathname || "/");
  let best: string | undefined;
  let bestLength = -1;
  for (const [rawPrefix, topic] of Object.entries(topics)) {
    const prefix = normalizePath(rawPrefix);
    const hit = prefix === "/" || path === prefix || path.startsWith(`${prefix}/`);
    if (hit && prefix.length > bestLength) {
      best = topic;
      bestLength = prefix.length;
    }
  }
  return best;
}
