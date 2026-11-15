/**
 * Ссылки в ответе консультанта (T35, OWASP LLM05). Ответ выводится простым текстом: React экранирует всё, HTML и
 * Markdown не разбираются, `dangerouslySetInnerHTML` в проекте нет — ссылкой в ответе может стать только строка,
 * которую человек сам скопирует. Здесь вторая линия: из текста убирается всё, что похоже на ссылку не туда.
 *
 * Разрешено: относительные пути раздела базы `/kb…` и адреса на доменах из ANSWER_LINK_HOSTS (по умолчанию —
 * никаких). Markdown-ссылка `[текст](адрес)` сводится к тексту: ответ, который прячет адрес за подписью, —
 * приём фишинга.
 */

/** Домены, на которые ответ может ссылаться (поддомены включены). Пусто — только /kb. Менять осознанно. */
export const ANSWER_LINK_HOSTS: readonly string[] = [];

export const HIDDEN_LINK = "[ссылка скрыта]";

const MARKDOWN_LINK = /!?\[([^\]\n]*)\]\(\s*<?([^)\s>]*)>?[^)]*\)/g;
// Адрес до пробела; знаки препинания в конце фразы («…evil.ru/x.») к адресу не относятся.
const BARE_URL = /\b(?:https?:\/\/|www\.)[^\s<>"']*[^\s<>"'.,;:!?)\]]/gi;
const SCHEME_URL = /\b(?:javascript|data|vbscript|file):[^\s<>"']*[^\s<>"'.,;:!?]/gi;

/** Можно ли вести по этой ссылке. */
export function isAllowedLink(href: string, hosts: readonly string[] = ANSWER_LINK_HOSTS): boolean {
  const value = href.trim();
  if (value === "/kb" || value.startsWith("/kb/") || value.startsWith("/kb?") || value.startsWith("/kb#")) return true;
  if (value.startsWith("//") || !/^(?:https?:\/\/|www\.)/i.test(value)) return false;
  try {
    const host = new URL(value.startsWith("www.") ? `https://${value}` : value).hostname.toLowerCase();
    return hosts.some((h) => host === h.toLowerCase() || host.endsWith(`.${h.toLowerCase()}`));
  } catch {
    return false;
  }
}

/** Текст ответа без чужих ссылок: Markdown-ссылки — в подпись, неразрешённые адреса — в пометку. */
export function safeAnswerText(text: string, hosts: readonly string[] = ANSWER_LINK_HOSTS): string {
  return text
    .replace(MARKDOWN_LINK, (_m, label: string, href: string) => (label.trim() ? label : isAllowedLink(href, hosts) ? href : ""))
    .replace(SCHEME_URL, HIDDEN_LINK)
    .replace(BARE_URL, (url) => (isAllowedLink(url, hosts) ? url : HIDDEN_LINK));
}
