"use client";

import {
  Briefcase,
  Building2,
  Droplets,
  Factory,
  House,
  Network,
  Store,
  UserRound,
  Warehouse,
  Wrench,
  Zap,
} from "lucide-react";
import { useState } from "react";
import { PRIMARY_ROLES, ROLES, type RoleId, type RoleSource, SEGMENT_ROLES, roleLabel } from "@/lib/roles";
import { cn } from "@/lib/utils";
import type { Starter } from "./starters";

const ICONS: Record<RoleId, Starter["icon"]> = {
  business: Briefcase,
  engineer: Wrench,
  housing: House,
  grid: Network,
  mts_manager: UserRound,
  industry: Factory,
  supplier: Zap,
  utility: Droplets,
  landlord: Building2,
  retail: Store,
  warehouse: Warehouse,
};

/** Быстрые вопросы роли — с её значком. */
export function roleStarters(role: RoleId): Starter[] {
  return ROLES[role].starters.map((s) => ({ ...s, icon: ICONS[role] }));
}

const chip =
  "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12.5px] transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none";

/**
 * Необязательные кнопки роли (T15): «Бизнес / Энергетик / СНТ, УК, ТСЖ / Сетевая компания / Менеджер МТС /
 * Другое». Ввод не блокируют: чат отвечает и без роли. «Другое» раскрывает сегменты базы из «Навигации по типу
 * компании»; выбранную роль можно снять.
 */
export function RolePicker({
  value,
  onPick,
  compact,
  caption = true,
  className,
}: {
  value?: RoleId | "";
  onPick: (role: RoleId | "") => void;
  compact?: boolean;
  /** Подпись «Кто вы? …» над кнопками; у раскрытой метки роли она лишняя. */
  caption?: boolean;
  className?: string;
}) {
  const segment = !!value && SEGMENT_ROLES.includes(value);
  const [more, setMore] = useState(segment);
  const item = (id: RoleId) => {
    const Icon = ICONS[id];
    const on = value === id;
    return (
      <li key={id}>
        <button
          type="button"
          aria-pressed={on}
          title={on ? "Снять" : undefined}
          onClick={() => onPick(on ? "" : id)}
          className={cn(
            chip,
            on
              ? "border-primary/60 bg-primary/10 text-foreground"
              : "border-border/80 text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          <Icon className="size-3.5" strokeWidth={1.75} />
          {ROLES[id].label}
        </button>
      </li>
    );
  };
  return (
    <div className={cn("space-y-1.5", className)}>
      {caption && (
        <p className={cn("text-xs text-muted-foreground", !compact && "text-center")}>
          Кто вы? Подберу вопросы под вашу задачу — можно не выбирать
        </p>
      )}
      <ul
        className={cn("flex flex-wrap gap-1.5", !compact && "justify-center")}
        aria-label="Роль — необязательно"
      >
        {PRIMARY_ROLES.map(item)}
        <li>
          <button
            type="button"
            aria-expanded={more}
            onClick={() => setMore((v) => !v)}
            className={cn(
              chip,
              segment
                ? "border-primary/60 bg-primary/10 text-foreground"
                : "border-dashed border-border text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            Другое
          </button>
        </li>
        {more && SEGMENT_ROLES.map(item)}
      </ul>
    </div>
  );
}

/** Тихая метка над полем ввода: «Похоже, вы — сетевая компания · изменить». */
export function RoleBadge({
  role,
  source,
  onPick,
  compact,
}: {
  role: RoleId;
  source?: RoleSource;
  onPick: (role: RoleId | "") => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cn(compact ? "mb-1.5" : "mb-2")}>
      <p className={cn("text-xs text-muted-foreground", !compact && "text-center")}>
        {roleLabel(role, source)}
        {" · "}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="underline decoration-dotted underline-offset-2 hover:text-foreground"
        >
          {open ? "готово" : "изменить"}
        </button>
      </p>
      {open && (
        <RolePicker
          value={role}
          compact={compact}
          caption={false}
          className="mt-1.5"
          onPick={(next) => {
            onPick(next);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}
