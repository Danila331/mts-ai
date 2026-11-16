import { ArrowUpRight, Factory, Gauge, Search, Sun, TrendingDown, Zap } from "lucide-react";

// Стартовые вопросы — по одному на продукт и типовые ситуации клиента (формулировки свои, не из демо-набора жюри).
export const STARTERS = [
  { icon: Sun, label: "Окупаемость солнечной станции", text: "Окупится ли солнечная станция на крыше нашего склада?" },
  { icon: Search, label: "Потери в СНТ", text: "У нас в СНТ платим за свет больше, чем потребляем. Что можно сделать?" },
  { icon: Gauge, label: "Учёт на 40 объектах", text: "Хотим автоматически собирать показания со счётчиков на 40 объектах. Это возможно?" },
  { icon: Zap, label: "Оптовый рынок", text: "Имеет ли смысл нам выходить на оптовый рынок электроэнергии?" },
  { icon: TrendingDown, label: "Ценовая категория", text: "Как понять, что мы платим по неоптимальной ценовой категории?" },
  { icon: Factory, label: "Расходы завода", text: "Мы небольшой завод. С чего начать, чтобы снизить расходы на электричество?" },
];

/** Подсказки первого вопроса: короткие пилюли под полем ввода (полный вопрос — в подсказке и уходит при клике). */
export type Starter = { icon: typeof Sun; label: string; text: string };

export function Starters({
  onPick,
  compact,
  items = STARTERS,
  limit = 4,
}: {
  onPick: (text: string) => void;
  compact?: boolean;
  items?: Starter[];
  /** Сколько вопросов показать в компактном виде (виджет: пустой экран короче, чтобы не прятать приветствие). */
  limit?: number;
}) {
  if (compact) {
    return (
      <ul className="divide-y border-y" aria-label="Примеры вопросов">
        {items.slice(0, limit).map(({ icon: Icon, label, text }) => (
          <li key={label}>
            <button
              type="button"
              onClick={() => onPick(text)}
              className="group/q -mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-md px-2 py-2.5 text-left text-[13px] leading-snug outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <Icon className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
              <span className="min-w-0 flex-1">{text}</span>
              <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/q:opacity-100 group-focus-visible/q:opacity-100" />
            </button>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <ul className="flex flex-wrap justify-center gap-1.5" aria-label="Примеры вопросов">
      {items.map(({ icon: Icon, label, text }) => (
        <li key={label}>
          <button
            type="button"
            onClick={() => onPick(text)}
            title={text}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[13px] text-muted-foreground transition-colors outline-none hover:border-input hover:bg-surface hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <Icon className="size-3.5" strokeWidth={1.75} />
            {label}
          </button>
        </li>
      ))}
    </ul>
  );
}
