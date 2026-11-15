// Удобное время звонка (T4) — предпочтение, а не запись в календарь.
//
// База запрещает обещать точное время звонка, имя специалиста и содержание разговора (раздел «Обратный звонок»,
// knowledge-base/00-reference/03-calculation-and-requests.md). Поэтому клиент выбирает только часть дня и часовой
// пояс, а тексты говорят «учтём», а не «позвоним в…». Это проверяет callback.test.ts по строкам компонентов.

export type CallbackTime = "morning" | "day" | "evening" | "any";

/** То, что уходит в POST /api/lead как `callback` (backend: lead.Callback). */
export interface CallbackPreference {
  time: CallbackTime | "";
  timezone: string;
}

/** Варианты части дня — те же значения, что принимает сервер (lead.CallbackTimes). */
export const CALLBACK_TIMES: { value: CallbackTime; label: string }[] = [
  { value: "morning", label: "Утро" },
  { value: "day", label: "День" },
  { value: "evening", label: "Вечер" },
  { value: "any", label: "Любое" },
];

export const CALLBACK_QUESTION = "Когда удобнее звонок";
export const CALLBACK_HINT = "Это пожелание, а не запись на время: точное время звонка заранее не обещаем.";
export const LEAD_SAVED_TITLE = "Заявка сохранена";
/** После отправки, если клиент выбрал время: учтём, а не «позвоним в…». */
export const CALLBACK_NOTED = "Менеджер учтёт удобное время.";
/** После отправки без выбранного времени. */
export const CALLBACK_PLAIN = "Менеджер свяжется с вами.";
/** Текст после отправки из ROADMAP (T4). */
export const LEAD_SAVED = `${LEAD_SAVED_TITLE}. ${CALLBACK_NOTED}`;

export const callbackNote = (c: CallbackPreference) => (c.time ? CALLBACK_NOTED : CALLBACK_PLAIN);
/** Текст после отправки; note — оговорка типа заявки (T17, lead-kinds.ts), например про предварительную оценку. */
export const leadSavedText = (c: CallbackPreference, note = "") =>
  `${LEAD_SAVED_TITLE}. ${note ? `${note} ` : ""}${callbackNote(c)}`;

/** Часовые пояса России с городом для подписи. Сдвиг от UTC не хранится, а считается браузером (Intl). */
export const RU_TIMEZONES: { zone: string; city: string }[] = [
  { zone: "Europe/Kaliningrad", city: "Калининград" },
  { zone: "Europe/Moscow", city: "Москва" },
  { zone: "Europe/Samara", city: "Самара" },
  { zone: "Asia/Yekaterinburg", city: "Екатеринбург" },
  { zone: "Asia/Omsk", city: "Омск" },
  { zone: "Asia/Krasnoyarsk", city: "Красноярск" },
  { zone: "Asia/Irkutsk", city: "Иркутск" },
  { zone: "Asia/Yakutsk", city: "Якутск" },
  { zone: "Asia/Vladivostok", city: "Владивосток" },
  { zone: "Asia/Magadan", city: "Магадан" },
  { zone: "Asia/Kamchatka", city: "Камчатка" },
];

/** Часовой пояс браузера; если браузер его не назвал — Москва. */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Moscow";
  } catch {
    return "Europe/Moscow";
  }
}

/** Сдвиг пояса от UTC по данным браузера: «UTC+3». Пусто — браузер не знает пояс. */
export function utcOffset(zone: string, at: Date = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value;
    if (!part) return "";
    return part === "GMT" ? "UTC" : part.replace("GMT", "UTC");
  } catch {
    return "";
  }
}

/** Варианты для выбора пояса: пояса России, а пояс браузера вне списка — первым. */
export function timezoneOptions(current: string, at: Date = new Date()): { value: string; label: string }[] {
  const list = RU_TIMEZONES.map(({ zone, city }) => ({ value: zone, label: label(city, utcOffset(zone, at)) }));
  if (current && !RU_TIMEZONES.some((z) => z.zone === current)) {
    list.unshift({ value: current, label: label(current.replace(/_/g, " "), utcOffset(current, at)) });
  }
  return list;
}

const label = (name: string, offset: string) => (offset ? `${name} (${offset})` : name);

/**
 * Часть дня по словам клиента в паспорте («лучше вечером», «с утра»), чтобы предвыбрать кнопку. Только подсказка:
 * клиент видит выбор и может его поменять. Не угадали — ничего не выбрано.
 */
export function guessTime(text: string): CallbackTime | "" {
  const t = text.toLowerCase();
  if (/утр/.test(t)) return "morning";
  if (/вечер/.test(t)) return "evening";
  if (/(^|\s)(днём|днем|день|обед|после обеда)/.test(t)) return "day";
  if (/любое|когда угодно|в любое/.test(t)) return "any";
  return "";
}
