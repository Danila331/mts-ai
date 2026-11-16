// Уменьшение крупного фото в браузере перед распознаванием (T9). Снимок телефона — 3–8 МБ и 4000 px, а прокси
// Vercel пропускает тело запроса до 4,5 МБ; для чтения текста хватает 2400 px. Всё — в памяти вкладки:
// ни файл, ни уменьшенная копия никуда, кроме запроса распознавания, не уходят.
import { SHRINK_SIDE, fitSize, needsShrink } from "./document-text";

/** Крупное фото — JPEG поменьше; маленькое, PDF или то, что браузер не смог прочитать, — как есть. */
export async function shrinkImage(file: File, type: string): Promise<{ blob: Blob; type: string }> {
  if (!type.startsWith("image/") || typeof createImageBitmap !== "function") return { blob: file, type };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // Браузер не читает формат — пусть решает сервер по сигнатуре.
    return { blob: file, type };
  }
  try {
    if (!needsShrink(file.size, bitmap.width, bitmap.height)) return { blob: file, type };
    const { width, height } = fitSize(bitmap.width, bitmap.height, SHRINK_SIDE);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { blob: file, type };
    // Белая подложка: у PNG с прозрачностью текст на чёрном фоне JPEG не прочитать.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
    return blob && blob.size < file.size ? { blob, type: "image/jpeg" } : { blob: file, type };
  } finally {
    bitmap.close();
  }
}
