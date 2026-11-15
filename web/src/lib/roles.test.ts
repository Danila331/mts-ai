// node --experimental-strip-types --test src/lib/*.test.ts (npm test): автоопределение роли-подсказки (T15).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PRIMARY_ROLES,
  ROLES,
  ROLE_IDS,
  SEGMENT_ROLES,
  detectRole,
  isRole,
  resolveRole,
  roleFromOrgType,
  roleLabel,
  roleWords,
} from "./roles.ts";

// Те же фразы — в backend/internal/session/role_test.go: словарь фронта и службы даёт одну роль.
const CASES: [string, string | undefined][] = [
  ["Мы электросетевая компания, хотим находить потери", "grid"],
  ["Мы — территориальная сетевая организация, 40 тысяч абонентов", "grid"],
  ["Я председатель СНТ, платим за свет больше, чем потребляем", "housing"],
  ["У нас в СНТ платим за свет больше, чем потребляем. Что можно сделать?", "housing"],
  ["Мы управляющая компания, 12 домов", "housing"],
  ["У нас завод, хотим снизить расходы на электричество", "industry"],
  ["Мы небольшой завод. С чего начать?", "industry"],
  ["Я главный энергетик комбината", "engineer"],
  ["Работаю энергетиком на заводе", "engineer"],
  ["Я региональный менеджер МТС, клиент спрашивает про оптовый рынок", "mts_manager"],
  ["Мой клиент — сеть магазинов", "mts_manager"],
  ["Мы энергосбытовая компания. Подойдёт ли нам поиск потерь?", "supplier"],
  ["Мы водоканал, хотим собирать показания", "utility"],
  ["У нас торговый центр, арендаторы платят по субсчётчикам", "landlord"],
  ["Бизнес-центр на 30 арендаторов", "landlord"],
  ["У нас сеть кофеен в трёх городах", "retail"],
  ["Окупится ли солнечная станция на крыше нашего склада?", "warehouse"],
  ["Мы малый бизнес, ИП, платим много за свет", "business"],
  // Третьи лица и общие вопросы — не роль.
  ["Сетевая компания отключила нам свет на сутки", undefined],
  ["Наш гарантирующий поставщик поднял цену", undefined],
  ["Хотим автоматически собирать показания со счётчиков на 40 объектах", undefined],
  ["Можно ли сложить мощность нескольких площадок?", undefined],
  ["Чем занимается энергетика МТС?", undefined],
  ["", undefined],
];

test("роль по реплике — детерминированно по словарю", () => {
  for (const [text, want] of CASES) assert.equal(detectRole([text]), want, text);
});

test("первая реплика, где клиент сказал о себе, решает", () => {
  assert.equal(detectRole(["Что такое поиск коммерческих потерь?", "Мы сетевая компания", "А склад у нас тоже есть"]), "grid");
  assert.equal(detectRole([]), undefined);
});

test("роль по типу организации из паспорта — без условия «о себе»", () => {
  const cases: [string, string | undefined][] = [
    ["электросетевая компания", "grid"],
    ["сетевая организация", "grid"],
    ["энергосбытовая компания", "supplier"],
    ["СНТ", "housing"],
    ["ТСЖ", "housing"],
    ["торговый центр", "landlord"],
    ["склад", "warehouse"],
    ["производственное предприятие", "industry"],
    ["ООО", "business"],
    ["школа", undefined],
    ["", undefined],
  ];
  for (const [text, want] of cases) assert.equal(roleFromOrgType(text), want, text);
  assert.equal(roleFromOrgType(undefined), undefined);
});

test("слова: регистр, «ё», знаки", () => {
  assert.deepEqual(roleWords("Мы — ЭЛЕКТРОСЕТЕВАЯ компания; подойдёт?"), ["мы", "электросетевая", "компания", "подойдет"]);
  assert.deepEqual(roleWords("бизнес-центр"), ["бизнес", "центр"]);
});

test("выбор клиента и найденная догадка держатся", () => {
  const grid = ["Мы электросетевая компания"];
  assert.deepEqual(resolveRole({}, grid), { role: "grid", roleSource: "auto" });
  assert.deepEqual(resolveRole({}, ["Сколько стоит?"], "СНТ «Рассвет»"), { role: "housing", roleSource: "auto" }, "из паспорта");
  assert.deepEqual(resolveRole({}, ["Сколько стоит?"]), {}, "роли нет — ничего не меняем");
  assert.deepEqual(resolveRole({ role: "engineer", roleSource: "client" }, grid), { role: "engineer", roleSource: "client" });
  assert.deepEqual(resolveRole({ role: "", roleSource: "client" }, grid), { role: "", roleSource: "client" }, "клиент снял роль");
  assert.deepEqual(resolveRole({ role: "warehouse", roleSource: "auto" }, grid), { role: "warehouse", roleSource: "auto" }, "метка не прыгает");
});

test("каталог: пять аудиторий кейса на виду, сегменты базы — за «Другое»", () => {
  assert.deepEqual(PRIMARY_ROLES, ["business", "engineer", "housing", "grid", "mts_manager"]);
  assert.deepEqual(SEGMENT_ROLES, ["industry", "supplier", "utility", "landlord", "retail", "warehouse"]);
  for (const id of ROLE_IDS) {
    const r = ROLES[id];
    assert.ok(r.label && r.who && r.greeting, id);
    assert.ok(r.starters.length >= 3, id);
    // Приветствие — пересказ базы без чисел: числа в базе идут с оговорками.
    assert.doesNotMatch(r.greeting, /\d/, id);
    for (const s of r.starters) assert.match(s.text, /\?$/, `${id}: ${s.text}`);
  }
  assert.ok(isRole("grid"));
  assert.ok(!isRole("admin"));
  assert.ok(!isRole(undefined));
  assert.equal(roleLabel("grid", "auto"), "Похоже, вы — сетевая компания");
  assert.equal(roleLabel("grid", "client"), "Вы — сетевая компания");
});
