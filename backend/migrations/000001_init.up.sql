-- Журнал ответов, заявки и оценки стенда.
--
-- Раньше всё это жило в web/.data/*.jsonl на диске Python-API. На
-- хостинге диск службы пропадает с каждой выкладкой, а вместе с ним —
-- заявки клиентов. Поэтому — база.

-- Ответы консультанта.
--
-- Промпт, выдача поиска и цитаты здесь не хранятся: это десятки
-- килобайт на ответ, и всё это ядро пересчитает по тому же вопросу.
-- Журнал отвечает на «о чём спрашивали», «что ответили» и «сколько это
-- заняло».
CREATE TABLE answers (
    -- id ответа, который выдаёт ядро (uuid hex). Им же фронт подписывает
    -- ответ в отладке, поэтому ключ — он, а не наш собственный.
    id         text PRIMARY KEY,
    mode       text        NOT NULL,
    question   text        NOT NULL,
    answer     text        NOT NULL,
    -- fallback — ответ-заглушка: модель недоступна или ответ не прошёл
    -- проверку. Их доля — первый признак, что с моделью что-то не так.
    fallback   boolean     NOT NULL DEFAULT false,
    error      text        NOT NULL DEFAULT '',
    model      text        NOT NULL DEFAULT '',
    -- turns — сколько реплик видела модель: длинный диалог и короткий
    -- вопрос отвечаются по-разному, и сравнивать их вперемешку нельзя.
    turns      integer     NOT NULL,
    -- jsonb, а не колонки: состав этапов меняется вместе с ядром, и
    -- каждый новый этап не должен стоить миграции.
    timings    jsonb       NOT NULL DEFAULT '{}'::jsonb,
    guard      jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Единственная регулярная выборка — «что спрашивали за последнее время».
CREATE INDEX answers_recent_idx ON answers (created_at DESC);

-- Заявки менеджеру.
CREATE TABLE leads (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Номер, который видит клиент: «№3f9a1c07b2». Короче uuid и
    -- читается по телефону.
    code       text        NOT NULL,
    name       text        NOT NULL DEFAULT '',
    phone      text        NOT NULL DEFAULT '',
    company    text        NOT NULL DEFAULT '',
    comment    text        NOT NULL DEFAULT '',
    summary    text        NOT NULL,
    -- Диалог целиком: резюме — пересказ, и менеджеру, которому оно
    -- показалось странным, нужно, что было сказано на самом деле.
    messages   jsonb       NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT leads_code_uq UNIQUE (code)
);

CREATE INDEX leads_recent_idx ON leads (created_at DESC);

-- Оценки ответов: 👍 и 👎.
CREATE TABLE feedback (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Сессия и сообщение — идентификаторы фронта. Внешнего ключа на
    -- answers нет намеренно: ответ мог не попасть в журнал, а оценка
    -- без него всё ещё оценка.
    session_id text        NOT NULL DEFAULT '',
    message_id text        NOT NULL DEFAULT '',
    rating     smallint    NOT NULL,
    comment    text        NOT NULL DEFAULT '',
    question   text        NOT NULL DEFAULT '',
    answer     text        NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),

    -- Шкала из двух кнопок. Ноль означал бы рассинхрон фронта с
    -- сервером, а не мнение.
    CONSTRAINT feedback_rating_known CHECK (rating IN (-1, 1))
);

CREATE INDEX feedback_recent_idx ON feedback (created_at DESC);
