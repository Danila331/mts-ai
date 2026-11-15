"use client";

import { Check, ChevronDown, ClipboardList, Pencil, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { Passport, PassportField, PassportGroup } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Обязательные поля продукта — те же списки базы, что считает сервер (internal/passport.Required). */
const REQUIRED: Record<PassportGroup, string[]> = {
  general: ["org_type", "object_type", "region", "task", "connected_power", "monthly_consumption", "metering"],
  wholesale: ["connected_power", "monthly_consumption", "consumption_profile", "voltage_class", "supplier", "price_category", "supply_points"],
  solar: ["region", "object_type", "site_area", "connected_power", "consumption_profile", "task"],
  platform: ["org_type", "meters", "collection_scheme", "metering_goal"],
  losses: ["metering_data"],
  recognition: ["resource_type", "meter_fleet", "image_channel", "photo_volume"],
  contacts: [],
};

function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function Row({
  field,
  flash,
  onSave,
}: {
  field: PassportField;
  flash: boolean;
  onSave: (value: string | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(field.value ?? "");
  const [saving, setSaving] = useState(false);
  const id = `passport-${field.key}`;

  const save = async () => {
    setSaving(true);
    try {
      await onSave(draft.trim() ? draft.trim() : null);
      setEditing(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось сохранить");
    } finally {
      setSaving(false);
    }
  };

  return (
    <li className={cn("grid grid-cols-[minmax(0,9.5rem)_minmax(0,1fr)] items-start gap-3 rounded-md px-2 py-1.5", flash && "kb-flash")}>
      <label htmlFor={id} className="pt-0.5 text-[12.5px] leading-snug text-muted-foreground">
        {field.label}
      </label>
      {editing ? (
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {field.options ? (
            <select
              id={id}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-[13px]"
              autoFocus
            >
              <option value="">— не указано —</option>
              {field.options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : (
            <input
              id={id}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
              maxLength={300}
              autoFocus
              className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-[13px] outline-none focus-visible:border-ring"
            />
          )}
          <button type="submit" disabled={saving} aria-label="Сохранить" className="flex size-7 items-center justify-center rounded-md hover:bg-muted">
            <Check className="size-3.5" />
          </button>
          <button type="button" onClick={() => setEditing(false)} aria-label="Отменить" className="flex size-7 items-center justify-center rounded-md hover:bg-muted">
            <X className="size-3.5" />
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => {
            setDraft(field.value ?? "");
            setEditing(true);
          }}
          className="group/value flex min-w-0 items-start gap-1.5 text-left text-[13px] leading-snug"
          aria-label={`${field.label}: ${field.value || "не указано"}. Изменить`}
        >
          <span className={cn("min-w-0 break-words", !field.value && "text-muted-foreground")}>
            {field.value || "—"}
          </span>
          <Pencil className="mt-0.5 size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/value:opacity-100 group-focus-visible/value:opacity-100" />
        </button>
      )}
    </li>
  );
}

/**
 * «Паспорт задачи»: что бот понял о задаче клиента, по полям чек-листов базы. Клиент видит паспорт и может
 * поправить любое поле — это повышает доверие, а менеджер получает структурированные данные, а не пересказ.
 * Поля, которые бот только что заполнил, коротко подсвечиваются.
 */
export function PassportCard({
  passport,
  onEdit,
  compact,
}: {
  passport: Passport;
  onEdit: (values: Record<string, string | null>) => Promise<unknown>;
  compact?: boolean;
}) {
  // Свёрнута по умолчанию: карточка липнет к верху ленты, и раскрытая целиком закрывала бы ответ (QA).
  const [open, setOpen] = useState(false);
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const seen = useRef<Record<string, string> | null>(null);

  // Подсветка на 1,5 с — только то, что заполнил бот после прошлого ответа.
  useEffect(() => {
    const now = Object.fromEntries(passport.fields.map((f) => [f.key, f.value ?? ""]));
    const before = seen.current;
    seen.current = now;
    if (!before) return;
    const changed = passport.fields.filter((f) => f.source === "bot" && f.value && before[f.key] !== f.value).map((f) => f.key);
    if (!changed.length) return;
    setFlash(new Set(changed));
    const t = setTimeout(() => setFlash(new Set()), 1500);
    return () => clearTimeout(t);
  }, [passport]);

  const shown = useMemo(() => {
    const keys = new Set([...REQUIRED[passport.product], ...REQUIRED.general]);
    return {
      task: passport.fields.filter((f) => f.group !== "contacts" && (keys.has(f.key) || f.value)),
      contacts: passport.fields.filter((f) => f.group === "contacts"),
    };
  }, [passport]);
  const filledAll = passport.fields.filter((f) => f.value).length;

  return (
    <section aria-label="Паспорт задачи" className="rounded-2xl border bg-background">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left"
      >
        <ClipboardList className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[13.5px]">
          {compact ? (
            <>
              <span className="font-medium">Что я понял о задаче</span>
              <span className="text-muted-foreground"> · {filledAll} {plural(filledAll, "поле", "поля", "полей")}</span>
            </>
          ) : (
            <>
              <span className="font-medium">Паспорт задачи</span>
              <span className="text-muted-foreground">
                {" "}
                · заполнено {passport.filled} из {passport.total} для: {passport.product_label}
              </span>
            </>
          )}
        </span>
        <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="max-h-[45vh] overflow-y-auto border-t px-1.5 pt-1.5 pb-2.5">
          <ul className="grid gap-0.5">
            {shown.task.map((f) => (
              <Row key={f.key} field={f} flash={flash.has(f.key)} onSave={async (v) => void (await onEdit({ [f.key]: v }))} />
            ))}
          </ul>
          <div className="mt-2 px-2 text-[12px] font-medium text-muted-foreground">Контакты для менеджера</div>
          <ul className="mt-0.5 grid gap-0.5">
            {shown.contacts.map((f) => (
              <Row key={f.key} field={f} flash={flash.has(f.key)} onSave={async (v) => void (await onEdit({ [f.key]: v }))} />
            ))}
          </ul>
          <p className="mt-2 px-2 text-[12px] leading-snug text-muted-foreground">
            Только то, что вы сказали сами. Нажмите на поле, чтобы поправить: ваша правка главнее.
          </p>
        </div>
      )}
    </section>
  );
}
