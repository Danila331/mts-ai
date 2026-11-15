// node --experimental-strip-types --test src/lib/*.test.ts (npm test): уровень объяснения (T16).
import assert from "node:assert/strict";
import { test } from "node:test";
import { LEVELS, LEVEL_IDS, isLevel, otherLevels } from "./level.ts";

test("уровни: два, у каждого подпись и кнопка", () => {
  assert.deepEqual([...LEVEL_IDS], ["simple", "technical"]);
  for (const id of LEVEL_IDS) {
    assert.ok(LEVELS[id].label && LEVELS[id].action && LEVELS[id].hint, id);
    assert.ok(isLevel(id));
  }
  assert.equal(isLevel("expert"), false);
  assert.equal(isLevel(undefined), false);
});

test("кнопка под ответом предлагает другой уровень", () => {
  assert.deepEqual(otherLevels("simple"), ["technical"]);
  assert.deepEqual(otherLevels("technical"), ["simple"]);
  assert.deepEqual(otherLevels(undefined), ["simple", "technical"]);
  assert.deepEqual(otherLevels(""), ["simple", "technical"]);
});

test("подсказки уровней не обещают новых фактов", () => {
  for (const id of LEVEL_IDS) assert.match(LEVELS[id].hint, /Факты те же/);
});
