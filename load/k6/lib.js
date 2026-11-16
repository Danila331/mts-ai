// Общее для сценариев k6 (T32). Нужен k6, собранный с xk6-sse:
//   xk6 build --with github.com/phymbert/xk6-sse   (или готовый бинарь)
// Адрес стенда: BASE_URL (по умолчанию Go-API на :8080), модель — любая, в т.ч. заглушка tests/mock_api.py.
import sse from "k6/x/sse";
import { Trend, Rate, Counter } from "k6/metrics";

export const BASE_URL = __ENV.BASE_URL || "http://127.0.0.1:8080";

// Время от отправки вопроса до первого куска текста (первая delta; без потока — до answer) и до готового ответа.
export const ttft = new Trend("time_to_first_token", true);
export const fullAnswer = new Trend("time_to_answer", true);
export const chatErrors = new Rate("chat_errors");
export const chatLimited = new Counter("chat_rate_limited");

export const QUESTIONS = [
  "Что нужно, чтобы подключить платформу учёта электроэнергии?",
  "Окупится ли солнечная станция на крыше склада?",
  "Как найти, где теряется электроэнергия в сетях СНТ?",
  "Какие приборы учёта поддерживает платформа?",
];

/** Один вопрос с историей → метрики. Возвращает текст ответа (для многоходового диалога). */
export function ask(messages, params = {}) {
  const started = Date.now();
  let first = 0;
  let answer = "";
  let failed = false;
  const res = sse.open(
    `${BASE_URL}/api/chat`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ messages, mode: "chat", ...params }),
      timeout: "120s",
    },
    function (client) {
      client.on("event", function (e) {
        const now = Date.now() - started;
        if (e.name === "delta" && !first) first = now;
        else if (e.name === "answer") {
          try { answer = JSON.parse(e.data).text || ""; } catch (_) { /* битый кадр — считаем ошибкой ниже */ }
          fullAnswer.add(now);
          if (!first) first = now;
          client.close();
        } else if (e.name === "error") {
          failed = true;
          client.close();
        }
      });
      client.on("error", function () { failed = true; });
    },
  );
  if (res.status === 429) chatLimited.add(1);
  else if (res.status !== 200) failed = true;
  if (first) ttft.add(first);
  else failed = true;
  chatErrors.add(failed && res.status !== 429);
  return answer;
}
