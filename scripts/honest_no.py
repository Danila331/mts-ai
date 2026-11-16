"""«Честные нет» (T26): бот прямо говорит, что продукт клиенту, скорее всего, не подойдёт, — по условию из базы.

Правило-несовместимость = условие из базы знаний (раздел + дословный текст) + детектор по тому, что клиент сам
сказал о себе в диалоге (и в паспорте задачи, если его передали). Принципы:

- Причина и альтернатива — дословный текст раздела базы (тест сверяет каждое правило с базой, числа тоже).
  Своих порогов, цифр и рублёвых расчётов здесь нет: пороги ниже — те, что названы в базе.
- Не категоричнее базы. Правило есть только там, где база говорит прямо: «невозможен», «не подходит, если»,
  «не предусмотрен», «не выставляет». Где база говорит «может», «рассматривается отдельно» (газ и тепло
  в распознавании показаний, мощность солнечной станции больше 500 кВт), правила нет. Если в базе есть
  оговорка, она входит в причину целиком («исключение возможно, если…», «технически возможно, экономически
  сомнительно»).
- Молчим, когда данных нет или они неоднозначны: мощность названа нижней границей («больше 500 кВт»),
  площадок несколько (мощности суммируются при электрической связности), кровля из шифера без возраста.
- Правило срабатывает на ту реплику, где о продукте или о мешающем факте сказано сейчас: плашка не
  повторяется под каждым следующим ответом про другое.

Только веб-режим chat (scripts/core_api.py): автопроверка (solution.py) этот модуль не видит.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date
from typing import Callable

OREM = "20-products/21-orem.md"
ASKUE = "20-products/22-askue.md"
SOLAR = "20-products/23-solar.md"
LOSSES = "20-products/24-losses.md"
PORTFOLIO = "20-products/20-portfolio.md"
GENERAL = "20-products/26-general.md"
MARKET = "10-energy/10-market.md"
SCOPE = "00-reference/02-product-scope-and-limits.md"


@dataclass(frozen=True)
class Ref:
    """Раздел базы: документ и цепочка заголовков (Chunk.path)."""

    doc: str
    path: str


@dataclass(frozen=True)
class Threshold:
    """Пороговое число правила и то, как оно записано в разделе базы."""

    name: str
    value: float
    text: str
    ref: Ref


@dataclass(frozen=True)
class Alternative:
    """Что подходит вместо: дословные фрагменты раздела базы; when — для какого клиента (None — для любого)."""

    parts: tuple
    ref: Ref
    when: re.Pattern | None = None


@dataclass(frozen=True)
class Rule:
    id: str
    product: str  # от чего отговариваем: продукт или ожидание от него
    reason: str  # почему — дословно из раздела ref
    ref: Ref
    topic: re.Pattern | None  # интерес к продукту в репликах клиента; None — его задаёт сам детектор
    detect: Callable  # Facts → фрагмент реплики клиента, по которому сработало, или ""
    alternatives: tuple = ()


# ---------- пороги из базы ----------
OREM_MIN_KW = Threshold("orem_min_kw", 750, "ниже 750 кВт", Ref(OREM, "Кому подходит > Порог доступа определяется присоединённой мощностью"))
SLATE_MAX_YEARS = Threshold("slate_years", 10, "больше 5-10 лет", Ref(SOLAR, "Кому подходит > Не подходит, если"))
# «Не менее года»: в базе число словом, поэтому в тексте порога его нет — это проверяет тест отдельно.
ARCHIVE_MIN_YEARS = Threshold("losses_archive_years", 1, "глубина архива не менее года", Ref(LOSSES, "Факты, которые можно утверждать"))
THRESHOLDS = (OREM_MIN_KW, SLATE_MAX_YEARS, ARCHIVE_MIN_YEARS)
MONTHS_IN_YEAR = 12  # единицы измерения, не порог базы


# ---------- факты из реплик ----------
def norm(text: str) -> str:
    return " ".join(str(text).lower().replace("ё", "е").split())


SENTENCE = re.compile(r"(?<=[.!?;])\s+|\n+")
NEGATION = re.compile(r"\b(?:не|нет|ни|без)\s+(?:\w+\s+)?$")


class Facts:
    """Нормализованные реплики клиента (и значения паспорта) — то, по чему работают детекторы."""

    def __init__(self, texts: list):
        self.texts = [norm(t) for t in texts if str(t).strip()]
        self.text = "\n".join(self.texts)
        self.sentences = [s for t in self.texts for s in SENTENCE.split(t) if s.strip()]


def hit(pattern: re.Pattern, text: str, negatable: bool = True) -> str:
    """Первое совпадение без отрицания прямо перед ним («мы не завод» — не завод)."""
    for m in pattern.finditer(text):
        if negatable and NEGATION.search(text[max(0, m.start() - 30):m.start()]):
            continue
        return m.group(0).strip()
    return ""


def p(source: str) -> re.Pattern:
    return re.compile(source)


# Интерес к продукту
T_OREM = p(r"оптов\w*\s+(?:рын|энерг|закуп)|\bорэм\b|\bна\s+опт\b|\bопт\b")
T_LOSSES = p(r"потер[ьияюе]\w*|хищени\w*|похищ\w*|ворую\w*|воровств\w*|краж\w*|безучетн\w*|неучтенн\w*")
T_SOLAR = p(r"солнечн\w*|\bсэс\b|панел\w*|фотоэлектр\w*|солнц\w*")

# Кто клиент
INDUSTRIAL = p(r"\bзавод\w*|фабрик\w*|комбинат\w*|промышленн\w*\s+(?:предприят|потребител|компан|производств)\w*"
               r"|\bпромпредприят\w*|производственн\w*\s+(?:предприят|компан|площадк)\w*|\bмы\s+производим")
GRID = p(r"сетев\w*\s+(?:компан|организац|предприят)\w*|электросет\w*|\bтсо\b|\bрэс\b|\bпэс\b|россет\w*|\bмрск\b")
SBYT = p(r"энергосбыт\w*|сбытов\w*\s+(?:компан|организац)\w*|\bсбыт\b|гарантирующ\w*\s+поставщик\w*")
RETAIL_OFFICE = p(r"\bофис\w*|магазин\w*|торгов\w*\s+(?:центр|сет|компан|точк|площад)\w*|\bторговл\w*|\bтр?ц\b|\bбц\b"
                  r"|бизнес-центр\w*|\bит[- ]?компан\w*|\bкафе\b|ресторан\w*|общепит\w*|ретейл\w*|ритейл\w*")
PRODUCTION = p(r"производ\w*|завод\w*|фабрик\w*|комбинат\w*|\bцех\w*|промышлен\w*")
MALL = p(r"торгов\w*\s+центр\w*|\bтр?ц\b|\bбц\b|бизнес-центр\w*|арендодат\w*|арендатор\w*")
RETAIL = p(r"магазин\w*|торгов\w*\s+(?:сет|точк)\w*|ретейл\w*|ритейл\w*|\bкафе\b|ресторан\w*|общепит\w*")

# Просьба, а не рассказ о своём процессе: «вы выставите квитанции?», «нужен энергоаудит».
REQUEST = p(r"\?|нуж\w*|надо\b|хоти\w*|хотел\w*|хочу\b|можете|сможете|сможет|будете|умеет|чтобы|интересует")


# ---------- детекторы ----------
NUMBER = r"(\d{1,3}(?:[  ]\d{3})+|\d+(?:[.,]\d+)?)"
POWER = p(NUMBER + r"\s*(квт|мвт)(?!\w)(?!\s*(?:[·*\-/.]\s*)?ч(?:ас)?\b)(?!\s*в\s+(?:месяц|год|сутки|день|час))")
LOWER_BOUND = p(r"(?:\b(?:более|больше|свыше|выше|от|не\s+менее|минимум)|>)\s*$")
UPPER_BOUND_OK = p(r"\b(?:не\s+более|не\s+больше|до|меньше|менее|около|примерно|порядка|всего|только)\s*$")
NOT_CONNECTED_POWER = p(r"станци\w*|панел\w*|\bсэс\b|солнеч\w*|генерац\w*|инвертор\w*|накопител\w*|дизел\w*|излиш\w*")
SEVERAL_SITES = p(r"площадк\w*\s+по\b|\bпо\s+\d[\d\s,.]*\s*(?:квт|мвт)|каждо\w*\s+(?:площадк|объект|здани)\w*"
                  r"|(?:нескольк\w*|двух|трех|две|два|три|четыре|пять|\d+)\s+"
                  r"(?:площад|объект|филиал|предприят|здани|корпус|точ\w*\s+поставки)\w*")


def _number(raw: str) -> float:
    return float(raw.replace(" ", "").replace(" ", "").replace(",", "."))


def connected_power(f: Facts) -> list:
    """Названная клиентом мощность, кВт: [(значение, фрагмент)]. Нижние границы и мощность станции — не в счёт."""
    out = []
    for s in f.sentences:
        if NOT_CONNECTED_POWER.search(s):
            continue
        for m in POWER.finditer(s):
            before = s[max(0, m.start() - 20):m.start()]
            if LOWER_BOUND.search(before) and not UPPER_BOUND_OK.search(before):
                return []  # «больше 500 кВт» — сравнить с порогом нельзя: молчим
            kw = _number(m.group(1)) * (1000 if m.group(2) == "мвт" else 1)
            out.append((kw, m.group(0)))
    return out


def orem_below_threshold(f: Facts) -> str:
    if hit(SEVERAL_SITES, f.text):
        return ""  # мощности площадок суммируются при электрической связности — по одной цифре не решить
    powers = connected_power(f)
    if not powers or any(kw >= OREM_MIN_KW.value for kw, _ in powers):
        return ""
    return max(powers)[1]


ISOLATED = p(r"камчат\w*|магадан\w*|сахалин\w*|чукот\w*")
OREM_MEMBER = p(r"уже\s+(?:являемся\s+|стали\s+|мы\s+)?(?:участник|субъект)\w*\s+(?:оптов|орэм|рынк)\w*"
                r"|уже\s+(?:вышли|работаем|находимся|торгуем)\s+на\s+(?:оптов\w*\s+рын\w*|орэм|опт)\b")


def orem_no_production(f: Facts) -> str:
    if hit(PRODUCTION, f.text):
        return ""
    return hit(RETAIL_OFFICE, f.text)


def losses_industrial(f: Facts) -> str:
    if hit(GRID, f.text) or hit(SBYT, f.text):
        return ""  # сетевая компания — целевой клиент; сбыт — отдельное правило
    return hit(INDUSTRIAL, f.text)


def losses_sbyt(f: Facts) -> str:
    if hit(GRID, f.text):
        return ""  # «есть сетевые организации на балансе» — исключение из базы: не отговариваем
    return hit(SBYT, f.text)


MONTHLY_ONLY = p(r"(?:только|лишь)\s+(?:ежемесячн|месячн)\w*\s+(?:показани|данн)\w*"
                 r"|показани\w*\s+(?:снимаем|собираем|получаем|передают|приходят|есть)\s+(?:только\s+)?(?:раз|один\s+раз)\s+в\s+месяц")
NO_ARCHIVE = p(r"нет\s+(?:никакого\s+|исторического\s+|своего\s+)?архив\w*|архив\w*\s+(?:данных\s+)?(?:у\s+нас\s+)?нет")
SHORT_ARCHIVE = p(r"(?:архив|истори|данн)\w*[^.?!;]{0,30}?(?:за|на|всего|только)\s+(?:последние\s+)?(\d+)\s*(?:мес|месяц)\w*"
                  r"|(?:архив|истори|данн)\w*[^.?!;]{0,30}?(?:полгода|пол\s+года|квартал|несколько\s+месяцев)")


def losses_no_data(f: Facts) -> str:
    found = hit(MONTHLY_ONLY, f.text) or hit(NO_ARCHIVE, f.text, negatable=False)
    if found:
        return found
    for m in SHORT_ARCHIVE.finditer(f.text):
        if m.group(1) is None or int(m.group(1)) < ARCHIVE_MIN_YEARS.value * MONTHS_IN_YEAR:
            return m.group(0)
    return ""


ON_PREM = p(r"(?:на|в)\s+(?:наш|сво|собственн)\w*\s+(?:сервер|контур|инфраструктур|цод|дата-центр)\w*|on-?prem\w*"
            r"|в\s+закрыт\w*\s+контур\w*|локальн\w*\s+(?:установк|развертыван)\w*|без\s+(?:облака|выхода\s+в\s+интернет)")

PRIVATE_HOUSE = p(r"частн\w*\s+(?:жил\w*\s+)?дом\w*|(?:для|в|на)\s+(?:сво|наш|мо)\w*\s+(?:частн\w*\s+)?(?:дом|дач|коттедж)\w*"
                  r"|\bкоттедж\w*|загородн\w*\s+дом\w*|\bдля\s+дома\b|\bна\s+даче\b")
NOT_PRIVATE = p(r"многоквартир\w*|\bмкд\b|управляющ\w*|\bтсж\b|\bснт\b|товарищ\w*|садовод\w*|компан\w*|предприят\w*|\bооо\b|\bип\b")


def solar_private_house(f: Facts) -> str:
    return "" if hit(NOT_PRIVATE, f.text) else hit(PRIVATE_HOUSE, f.text)


NIGHT = p(r"(?:в\s+основном|преимущественно|только|главным\s+образом)\s+(?:\w+\s+){0,2}?(?:ночью|по\s+ночам|в\s+ночное\s+время)"
          r"|(?:ночью|по\s+ночам)\s+(?:\w+\s+){0,2}?(?:в\s+основном|преимущественно)")
SLATE = p(r"шифер\w*")
AGE = p(r"(\d+)\s*(?:лет|год)")
OLD = p(r"\bстар(?!ше)\w*|советск\w*|ветх\w*")


def solar_old_slate(f: Facts) -> str:
    for s in f.sentences:
        if not hit(SLATE, s):
            continue
        # «1985 года» — год, а не возраст: считаем возраст от текущего года.
        ages = [int(a) if int(a) < 1900 else date.today().year - int(a) for a in AGE.findall(s)]
        if any(a > SLATE_MAX_YEARS.value for a in ages):
            return f"{hit(SLATE, s)}, {AGE.search(s).group(0)}"
        if not ages and hit(OLD, s):
            return f"{hit(OLD, s)} {hit(SLATE, s)}"
    return ""


BACKUP = p(r"(?:при|во\s+время|на\s+случай|в\s+случае|если|когда)\s+(?:\w+\s+){0,2}?(?:отключ|пропад|авари|блэкаут|отруб|выруб)\w*"
           r"|резервн\w*\s+(?:питани|источник|электроснабжени)\w*|бесперебойн\w*|автономн\w*\s+(?:питани|работ|электроснабжени)\w*"
           r"|(?:отключают|пропадает|вырубают)\s+(?:свет|электричеств\w*|электроэнерги\w*)")
HYBRID = p(r"гибрид\w*|накопител\w*|аккумулятор\w*")


def solar_grid_backup(f: Facts) -> str:
    return "" if hit(HYBRID, f.text) else hit(BACKUP, f.text)


BILLING = p(r"квитанци\w*|выстав\w*\s+(?:\w+\s+){0,2}?(?:сч[её]т|квитанци)\w*|расч[её]т\w*\s+с\s+(?:абонент|жител|арендатор)\w*\s+в\s+рубл\w*")
OWN_BILLING = p(r"\bмы\s+(?:сами\s+)?(?:выставля|печата|формиру|рассыла)\w*")
AUDIT = p(r"энергоаудит\w*|энергетическ\w*\s+обследовани\w*|энергообследовани\w*")


def requested(pattern: re.Pattern, exclude: re.Pattern | None = None) -> Callable:
    """Клиент просит это от нас: в той же фразе есть просьба или вопрос, а не рассказ о своём процессе."""
    def detect(f: Facts) -> str:
        for s in f.sentences:
            found = hit(pattern, s)
            if found and hit(REQUEST, s, negatable=False) and not (exclude and exclude.search(s)):
                return found
        return ""
    return detect


BUY_FROM_MTS = p(r"(?:купить|покупать|приобрета\w*|приобрести|брать|получать)\s+(?:\w+\s+){0,2}?электроэнерги\w*\s+(?:у|от)\s+(?:вас|мтс)\b"
                 r"|(?:вы|мтс)\s+(?:продает|продаете|поставляет|поставляете)\s+(?:\w+\s+)?электр\w*"
                 r"|(?:стать|станете|станет|будете)\s+(?:нашим\s+)?(?:поставщик|энергосбыт)\w*")


def matcher(pattern: re.Pattern, negatable: bool = True) -> Callable:
    return lambda f: hit(pattern, f.text, negatable)


def when_all(*detectors: Callable) -> Callable:
    """Все условия вместе; в ответ — фрагмент последнего (самого конкретного)."""
    def detect(f: Facts) -> str:
        found = ""
        for d in detectors:
            found = d(f)
            if not found:
                return ""
        return found
    return detect


# ---------- правила ----------
NOT_FIT = "Кому подходит > Не подходит, если"

RULES = (
    Rule(
        "orem_below_750", "Выход на оптовый рынок",
        "Присоединённая мощность ниже 750 кВт - выход на оптовый рынок невозможен. "
        "Это регуляторное ограничение, обойти его нельзя.",
        OREM_MIN_KW.ref, T_OREM, orem_below_threshold,
        (Alternative(("В зависимости от задачи могут быть релевантны анализ ценовой категории, солнечная "
                      "электростанция и платформа учёта.",),
                     Ref(PORTFOLIO, "Навигация по типу компании > Промышленное предприятие")),),
    ),
    Rule(
        "orem_isolated_system", "Выход на оптовый рынок",
        "В изолированных энергосистемах оптового рынка не существует: это Камчатка, Магадан, Сахалин, Чукотка.",
        Ref(MARKET, "Где оптового рынка нет"), T_OREM, matcher(ISOLATED),
        (Alternative(("Для таких территорий обсуждаются независимый учёт и собственная генерация.",),
                     Ref(OREM, "Что мы не делаем")),),
    ),
    Rule(
        "orem_already_member", "Выход на оптовый рынок",
        "Предприятие уже является участником оптового рынка.",
        Ref(OREM, NOT_FIT), None, matcher(OREM_MEMBER),
        (Alternative(("В этом случае обсуждается не выход, а перевод точек учёта на независимую платформу.",),
                     Ref(OREM, NOT_FIT)),),
    ),
    Rule(
        "orem_no_production_load", "Выход на оптовый рынок",
        "Это торговля, офисы, услуги или ИТ без производственной нагрузки.",
        Ref(OREM, NOT_FIT), T_OREM, orem_no_production,
        (Alternative(("Облачная платформа учёта - прозрачный учёт по арендаторам без доступа в закрытые помещения.",),
                     Ref(PORTFOLIO, "Навигация по типу компании > Торговый или бизнес-центр, арендодатель"), MALL),
         Alternative(("Облачная платформа учёта - сравнение однотипных точек между собой и выявление аномального расхода.",),
                     Ref(PORTFOLIO, "Навигация по типу компании > Ретейл, общепит, сетевой бизнес"), RETAIL)),
    ),
    Rule(
        "losses_industrial", "Поиск коммерческих потерь",
        "У промышленного предприятия нет задачи искать хищения у абонентов.",
        Ref(LOSSES, "Кому подходит > Не подходит промышленным потребителям"), T_LOSSES, losses_industrial,
        (Alternative(("Для контроля собственного потребления, включая нецелевое, предназначена платформа учёта.",),
                     Ref(LOSSES, "Кому подходит > Не подходит промышленным потребителям")),),
    ),
    Rule(
        "losses_sbyt", "Поиск коммерческих потерь",
        "Ответственность за потери в сети, включая материальную, несут сетевые организации, а не сбытовые. "
        "Поэтому продукт решает задачу сетевой компании. Исключение возможно, если у сбытовой компании есть "
        "сетевые организации на балансе.",
        Ref(LOSSES, "Кому подходит > Не подходит энергосбытовым компаниям"), T_LOSSES, losses_sbyt,
        (Alternative(("Облачная платформа учёта", "Распознавание показаний по фото"),
                     Ref(PORTFOLIO, "Навигация по типу компании > Энергосбытовая компания")),),
    ),
    Rule(
        "losses_not_enough_data", "Поиск коммерческих потерь",
        "Минимально необходимые данные - суточные показания с разбивкой день и ночь, глубина архива не менее года.",
        ARCHIVE_MIN_YEARS.ref, T_LOSSES, losses_no_data,
        (Alternative(("Облачная платформа учёта - сбор и обработка данных с приборов.",
                      "Распознавание показаний по фото - сбор показаний с парка приборов, не подключённого к системе."),
                     Ref(PORTFOLIO, "Навигация по типу компании > Электросетевая компания")),),
    ),
    Rule(
        "losses_on_premises", "Поиск коммерческих потерь в контуре клиента",
        "Не разворачиваем решение в контуре клиента. Алгоритмы работают на инфраструктуре МТС, вариант установки "
        "на серверы клиента не предусмотрен.",
        Ref(LOSSES, "Что мы не делаем"), T_LOSSES, matcher(ON_PREM),
    ),
    Rule(
        "solar_private_house", "Солнечная электростанция",
        "Это частный жилой дом. Направление ориентировано на бизнес.",
        Ref(SOLAR, NOT_FIT), T_SOLAR, solar_private_house,
    ),
    Rule(
        "solar_night_load", "Солнечная электростанция",
        "Объект работает преимущественно ночью: выработка не совпадёт с нагрузкой.",
        Ref(SOLAR, NOT_FIT), T_SOLAR, matcher(NIGHT),
    ),
    Rule(
        "solar_old_slate", "Солнечная станция на шиферной кровле",
        "Кровля выполнена из шифера, которому больше 5-10 лет. Нормативный срок службы шифера около 30 лет, "
        "срок службы панелей 25 лет, поэтому панели переживут кровлю и потребуют демонтажа с последующим "
        "монтажом. Технически возможно, экономически сомнительно.",
        SLATE_MAX_YEARS.ref, T_SOLAR, solar_old_slate,
        (Alternative(("Земля. Требуются фундамент и металлоконструкции, стоимость монтажа заметно возрастает.",
                      "Возможен монтаж на вертикальные поверхности зданий."),
                     Ref(SOLAR, "Размещение")),),
    ),
    Rule(
        "solar_grid_backup", "Сетевая солнечная станция как резервное питание",
        "Сетевая станция при отключении внешней сети отключается вместе с сетью.",
        Ref(SOLAR, "Частые вопросы > Если пропадёт электричество, станция обеспечит объект"), T_SOLAR, solar_grid_backup,
        (Alternative(("Автономность обеспечивает гибридная конфигурация с накопителями.",),
                     Ref(SCOPE, "Солнечные электростанции")),),
    ),
    Rule(
        "askue_billing", "Квитанции и расчёты в рублях на платформе учёта",
        "Требуется выставление квитанций и расчёты с абонентами в рублях. Платформа ведёт учёт в киловатт-часах "
        "и готовит данные для начисления, но сама счета не выставляет.",
        Ref(ASKUE, NOT_FIT), None, requested(BILLING, OWN_BILLING),
    ),
    Rule(
        "askue_energy_audit", "Энергетическое обследование на платформе учёта",
        "Требуется энергетическое обследование объекта. Это отдельная услуга, которая в рамках платформы учёта "
        "не оказывается.",
        Ref(ASKUE, NOT_FIT), None, requested(AUDIT),
    ),
    Rule(
        "mts_not_supplier", "Покупка электроэнергии у МТС",
        "МТС не является энергосбытовой компанией, не продаёт электроэнергию и не выступает поставщиком.",
        Ref(GENERAL, "О компании и направлении > Продаёт ли МТС электроэнергию"), None, matcher(BUY_FROM_MTS),
        (Alternative(("Компания обеспечивает учёт, аналитику и сопровождение проектов, снижающих затраты на "
                      "электроэнергию.",),
                     Ref(GENERAL, "О компании и направлении > Продаёт ли МТС электроэнергию")),),
    ),
)

# Поля паспорта (backend/internal/passport) — всё, кроме контактов: «Компания» вида «ООО Энергосбыт…» — это
# название, а не тип организации.
CONTACT_KEYS = {"name", "phone", "company", "callback_preference"}


def passport_texts(passport) -> list:
    """Значения паспорта: {ключ: значение} или представление паспорта ({"fields": [{key, value}]})."""
    if not isinstance(passport, dict):
        return []
    if isinstance(passport.get("fields"), list):
        items = [(f.get("key"), f.get("value")) for f in passport["fields"] if isinstance(f, dict)]
    else:
        items = list(passport.items())
    return [str(v)[:300] for k, v in items if k not in CONTACT_KEYS and isinstance(v, str) and v.strip()]


def fired(turns: list, passport=None) -> list:
    """Сработавшие правила: [(правило, фрагмент реплики клиента)]."""
    user = [t["content"] for t in turns if t.get("role") == "user" and t.get("content")]
    if not user:
        return []
    every, last = Facts(passport_texts(passport) + user), Facts(user[-1:])
    out = []
    for rule in RULES:
        if rule.topic and not hit(rule.topic, every.text):
            continue
        fact = rule.detect(every)
        # Сейчас о нём речь: продукт или мешающий факт — в последней реплике клиента.
        if fact and ((rule.topic and hit(rule.topic, last.text)) or rule.detect(last)):
            out.append((rule, fact))
    return out


class Detector:
    """Правила, привязанные к разделам загруженной базы: id раздела для ссылки /kb?chunk=<id>.

    Раздел не нашёлся или текст в нём уже другой (базу поправили) — правило выключается: без опоры в базе
    плашку не показываем.
    """

    def __init__(self, kb):
        self.by_path = {(c.doc, c.path): c for c in kb.chunks}
        self.disabled = sorted({r.id for r in RULES if not self.supports(r)})

    def section(self, ref: Ref) -> dict | None:
        c = self.by_path.get((ref.doc, ref.path))
        if c is None:
            return None
        return {"chunk_id": c.id, "doc": c.doc, "title": c.title, "path": c.path}

    def supports(self, rule: Rule) -> bool:
        c = self.by_path.get((rule.ref.doc, rule.ref.path))
        if c is None or plain(rule.reason) not in plain(c.text):
            return False
        for alt in rule.alternatives:
            a = self.by_path.get((alt.ref.doc, alt.ref.path))
            if a is None or any(plain(part) not in plain(a.text) for part in alt.parts):
                return False
        return True

    def alternative(self, rule: Rule, f: Facts) -> dict | None:
        for alt in rule.alternatives:
            if alt.when is None or hit(alt.when, f.text):
                return {"text": "; ".join(alt.parts), "section": self.section(alt.ref)}
        return None

    def detect(self, turns: list, passport=None) -> list:
        """Поле honest_no события answer: [{rule, product, reason, fact, section, alternative}]."""
        texts = passport_texts(passport) + [t["content"] for t in turns if t.get("role") == "user"]
        every = Facts(texts)
        out = []
        for rule, fact in fired(turns, passport):
            if rule.id in self.disabled:
                continue
            out.append({
                "rule": rule.id,
                "product": rule.product,
                "reason": rule.reason,
                "fact": original(fact, texts),
                "section": self.section(rule.ref),
                "alternative": self.alternative(rule, every),
            })
        return out


def original(fact: str, texts: list) -> str:
    """Фрагмент так, как его написал клиент (регистр, «ё»), — для плашки; не нашёлся — как есть."""
    for t in texts:
        raw = " ".join(str(t).split())
        low = norm(raw)
        if len(low) == len(raw) and (i := low.find(fact)) >= 0:
            return raw[i:i + len(fact)]
    return fact


LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")


def plain(text: str) -> str:
    """Текст для сверки с базой: без markdown-ссылок, с одним пробелом между словами."""
    return " ".join(LINK.sub(r"\1", text).replace("ё", "е").split())
