// Многоходовый диалог: 4 реплики подряд с накопленной историей. k6 run load/k6/multiturn.js
import { sleep } from "k6";
import { ask } from "./lib.js";

export const options = {
  vus: Number(__ENV.VUS || 5),
  duration: __ENV.DURATION || "2m",
  thresholds: { time_to_first_token: ["p(95)<2500"], chat_errors: ["rate<0.01"] },
};

const TURNS = [
  "Мы небольшое предприятие, хотим снизить расходы на электроэнергию. С чего начать?",
  "А чем отличается АСКУЭ от платформы учёта?",
  "Что потребуется от нас для подключения?",
  "Спасибо. Какие следующие шаги?",
];

export default function () {
  const messages = [];
  for (const text of TURNS) {
    messages.push({ role: "user", content: text });
    const reply = ask(messages);
    if (!reply) break;
    messages.push({ role: "assistant", content: reply });
    sleep(2);
  }
}
