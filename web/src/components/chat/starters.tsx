import { Factory, Gauge, Search, Sun, TrendingDown, Zap } from "lucide-react";

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
export function Starters({ onPick, compact }: { onPick: (text: string) => void; compact?: boolean }) {
  if (compact) {
    return (
      <ul className="grid gap-1.5" aria-label="Примеры вопросов">
        {STARTERS.slice(0, 4).map(({ label, text }) => (
          <li key={label}>
            <button
              type="button"
              onClick={() => onPick(text)}
              className="w-full rounded-2xl border bg-background px-3.5 py-2.5 text-left text-[13.5px] leading-snug transition-colors hover:border-input hover:bg-muted"
            >
              {text}
            </button>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <ul className="flex flex-wrap justify-center gap-1.5" aria-label="Примеры вопросов">
      {STARTERS.map(({ icon: Icon, label, text }) => (
        <li key={label}>
          <button
            type="button"
            onClick={() => onPick(text)}
            title={text}
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border/80 px-3 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Icon className="size-[15px]" strokeWidth={1.75} />
            {label}
          </button>
        </li>
      ))}
    </ul>
  );
}
