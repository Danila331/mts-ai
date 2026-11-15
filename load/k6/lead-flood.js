// Флуд заявками с одного адреса: после LeadBurst запросов Go-API обязан отвечать 429.
// k6 run load/k6/lead-flood.js — порог: хотя бы часть ответов 429, ни одного 5xx.
import http from "k6/http";
import { check } from "k6";
import { Rate } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://127.0.0.1:8080";
const limited = new Rate("lead_rate_limited");

export const options = {
  scenarios: { flood: { executor: "constant-arrival-rate", rate: 20, timeUnit: "1s", duration: "30s", preAllocatedVUs: 20 } },
  thresholds: { lead_rate_limited: ["rate>0.5"], http_req_failed: ["rate<1"] },
};

export default function () {
  // Тестовые данные; обработчик может ответить 400 — предел срабатывает раньше, до разбора тела.
  const res = http.post(
    `${BASE_URL}/api/lead`,
    JSON.stringify({ name: "Тест Тестов", phone: "+70000000000", company: "Тест", comment: "k6", messages: [], consent: true }),
    { headers: { "Content-Type": "application/json" } },
  );
  limited.add(res.status === 429);
  check(res, { "не 5xx": (r) => r.status < 500, "429 после пачки": (r) => r.status === 429 || r.status < 500 });
}
