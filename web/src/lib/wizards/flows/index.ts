/**
 * Все мастера. Новый сценарий (T19, T20) — отдельный файл в этой папке и строка в {@link FLOWS}: общий тест
 * сверки с базой (`../wizards.test.ts`) пройдёт и по нему, движок при этом не меняется.
 */
import type { WizardFlow } from "../engine.ts";
import { DIAGNOSTICS } from "./diagnostics.ts";

export { DIAGNOSTICS };

export const FLOWS: readonly WizardFlow[] = [DIAGNOSTICS];

export function flowById(id: string): WizardFlow | undefined {
  return FLOWS.find((f) => f.id === id);
}
