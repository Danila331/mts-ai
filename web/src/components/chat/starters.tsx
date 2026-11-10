import { Factory, Gauge, Search, Sun, TrendingDown, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

// Стартовые вопросы — по одному на продукт и типовые ситуации клиента (формулировки свои, не из демо-набора жюри).
export const STARTERS = [
  { icon: Sun, label: "Солнечная станция", text: "Окупится ли солнечная станция на крыше нашего склада?" },
  { icon: Search, label: "Потери", text: "У нас в СНТ платим за свет больше, чем потребляем. Что можно сделать?" },
  { icon: Gauge, label: "Учёт", text: "Хотим автоматически собирать показания со счётчиков на 40 объектах. Это возможно?" },
  { icon: Zap, label: "Оптовый рынок", text: "Имеет ли смысл нам выходить на оптовый рынок электроэнергии?" },
  { icon: TrendingDown, label: "Тариф", text: "Как понять, что мы платим по неоптимальной ценовой категории?" },
  { icon: Factory, label: "Подбор", text: "Мы небольшой завод. С чего начать, чтобы снизить расходы на электричество?" },
];

export function Starters({ onPick, compact }: { onPick: (text: string) => void; compact?: boolean }) {
  return (
    <div className={cn("grid gap-2", compact ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2")}>
      {(compact ? STARTERS.slice(0, 4) : STARTERS).map(({ icon: Icon, label, text }) => (
        <button
          key={label}
          type="button"
          onClick={() => onPick(text)}
          className="group flex items-start gap-3 rounded-xl border bg-card p-3 text-left transition hover:border-brand/40 hover:bg-brand-soft/40"
        >
          <Icon className="mt-0.5 size-4 shrink-0 text-brand" />
          <span className="space-y-0.5">
            {!compact && <span className="block text-xs font-medium text-muted-foreground">{label}</span>}
            <span className="block text-sm leading-snug">{text}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
