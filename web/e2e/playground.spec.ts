import { expect, test, type Page } from "@playwright/test";

// Ручной прогон в проде 16.11.2026: «Новый диалог» с другой страницы (/playground?new=1) — вопрос уходил, диалог
// появлялся в «Недавних», а на экране оставался пустой чат: эффект ?new=1 перезапускался на каждом изменении чата и
// создавал новый пустой диалог. Бэкенд не нужен: ответ чата подменяется.
// Ответ той же формы, что у ядра (scripts/core_api.py): страница читает эти поля.
const PAYLOAD = {
  id: "a1",
  route: "answer",
  text: "Ответ готов.",
  fallback: false,
  error: "",
  mode: "chat",
  role: "",
  level: "",
  timings: { server_total: 1 },
  guard: {},
  trace: "",
  sources: [],
  citations: [{ sentence: "Ответ готов.", question: false, support: [], unsupported_numbers: [] }],
  retrieval: null,
  prompt: [],
  prompt_chars: 0,
  llm_calls: [],
  model: "test",
  streamed: false,
  revised: false,
  confidence: null,
  honest_no: [],
  suggestions: [],
};
const ANSWER = `event: answer\ndata: ${JSON.stringify(PAYLOAD)}\n\nevent: done\ndata: {}\n\n`;

async function mockChat(page: Page) {
  await page.route("**/api/chat", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", body: ANSWER }));
}

async function ask(page: Page, text: string) {
  const box = page.getByRole("textbox", { name: "Сообщение консультанту" });
  await box.fill(text);
  await box.press("Enter");
}

test("/playground?new=1: вопрос остаётся в открытом диалоге, адрес очищен", async ({ page }) => {
  await mockChat(page);
  await page.goto("/playground?new=1");
  await expect(page).toHaveURL(/\/playground$/);
  await ask(page, "Первый вопрос про учёт");
  const main = page.locator("main");
  await expect(main.getByText("Первый вопрос про учёт").first()).toBeVisible();
  await expect(main.getByText("Ответ готов.").first()).toBeVisible();
  // Ни пустого нового диалога, ни переключения: через секунду вопрос всё ещё на экране.
  await page.waitForTimeout(1000);
  await expect(main.getByText("Первый вопрос про учёт").first()).toBeVisible();
  await ask(page, "Второй вопрос в том же диалоге");
  await expect(main.getByText("Второй вопрос в том же диалоге").first()).toBeVisible();
  await expect(main.getByText("Первый вопрос про учёт").first()).toBeVisible();
});

test("/playground?s=<id>: выбранный диалог открывается и не теряется после нового вопроса", async ({ page }) => {
  await mockChat(page);
  await page.goto("/playground");
  await ask(page, "Вопрос старого диалога");
  await expect(page.locator("main").getByText("Ответ готов.").first()).toBeVisible();
  const id = await page.evaluate(() => {
    const raw = localStorage.getItem("eb.playground.sessions.v1");
    const data = raw ? JSON.parse(raw) : null;
    const list = Array.isArray(data) ? data : (data?.sessions ?? []);
    return list[0]?.id as string;
  });
  expect(id).toBeTruthy();
  await page.goto("/playground?new=1");
  await expect(page).toHaveURL(/\/playground$/);
  await page.goto(`/playground?s=${id}`);
  await expect(page).toHaveURL(/\/playground$/);
  const main = page.locator("main");
  await expect(main.getByText("Вопрос старого диалога").first()).toBeVisible();
  await ask(page, "Продолжение старого диалога");
  await page.waitForTimeout(1000);
  await expect(main.getByText("Продолжение старого диалога").first()).toBeVisible();
  await expect(main.getByText("Вопрос старого диалога").first()).toBeVisible();
});
