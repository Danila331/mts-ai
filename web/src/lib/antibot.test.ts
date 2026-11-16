// node --experimental-strip-types --test (npm test): антибот формы заявки (T35).
import assert from "node:assert/strict";
import { test } from "node:test";
import { HONEYPOT_FIELD, HONEYPOT_STYLE, MIN_FILL_MS, elapsedMs, remainingMs } from "./antibot.ts";

test("порог — две секунды, как на сервере", () => {
  assert.equal(MIN_FILL_MS, 2000);
});

test("сколько ещё подождать до порога", () => {
  assert.equal(remainingMs(1000, 1300), 1700, "прошло 0,3 с");
  assert.equal(remainingMs(1000, 3000), 0, "ровно порог");
  assert.equal(remainingMs(1000, 9000), 0);
  assert.equal(remainingMs(5000, 1000), MIN_FILL_MS, "часы ушли назад — ждём полный порог");
});

test("время для сервера не бывает отрицательным", () => {
  assert.equal(elapsedMs(1000, 4500), 3500);
  assert.equal(elapsedMs(5000, 1000), 0);
});

test("ловушка скрыта за краем экрана, а не display:none", () => {
  assert.equal(HONEYPOT_FIELD, "website");
  assert.equal(HONEYPOT_STYLE.position, "absolute");
  assert.ok(parseInt(HONEYPOT_STYLE.left, 10) < -1000);
  assert.ok(!("display" in HONEYPOT_STYLE));
});
