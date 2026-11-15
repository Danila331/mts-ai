// Рост от 1 до N параллельных диалогов: k6 run -e MAX_VUS=40 -e BASE_URL=http://127.0.0.1:8080 load/k6/ramp.js
// Лимиты Go-API (EB_LIMIT_CHAT_PER_MINUTE) на время замера нужно поднять или выключить (0), иначе упрёмся в 429.
import { sleep } from "k6";
import { ask, QUESTIONS } from "./lib.js";

const MAX = Number(__ENV.MAX_VUS || 20);

export const options = {
  scenarios: {
    ramp: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "30s", target: Math.max(2, Math.round(MAX / 4)) },
        { duration: "1m", target: Math.round(MAX / 2) },
        { duration: "1m", target: MAX },
        { duration: "30s", target: 0 },
      ],
    },
  },
  thresholds: {
    time_to_first_token: ["p(95)<2000"], // SLO из ROADMAP T32
    chat_errors: ["rate<0.01"],
  },
};

export default function () {
  ask([{ role: "user", content: QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)] }]);
  sleep(1 + Math.random() * 2);
}
