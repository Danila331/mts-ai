-- Полная переписка сессии (экран менеджера «Диалоги»; пункт 5 кейса —
-- история всех диалоговых сессий, включая разговоры без заявки).
--
-- Раньше разговор собирался из журнала answers: строка там — последний
-- вопрос клиента и ответ. Терялись вопросы, на которые ядро не ответило,
-- реплики до появления сессии (клиент уже говорил с ботом, когда сессия
-- завелась) и реплики, которые фронт добавил сам, не спрашивая ядро.
-- Теперь на каждый вопрос чата шлюз дописывает сюда то, чего в переписке
-- ещё нет, а ответ ложится вместе с записью в журнал.
--
-- Реплики — персональные данные так же, как заголовок сессии: строки
-- уходят вместе с сессией (ON DELETE CASCADE) по сроку хранения ответов
-- и при удалении по номеру (internal/privacy).
CREATE TABLE session_messages (
    id         bigserial PRIMARY KEY,
    session_id text        NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    -- Порядок в переписке: 1, 2, 3… Уникален внутри сессии.
    seq        integer     NOT NULL,
    role       text        NOT NULL,
    content    text        NOT NULL,
    -- Ответ консультанта знает свою строку журнала (answers.id): оттуда
    -- берутся разделы базы. Внешнего ключа нет: журнал чистится независимо.
    answer_id  text        NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT session_messages_role_known CHECK (role IN ('user', 'assistant')),
    CONSTRAINT session_messages_seq_uniq UNIQUE (session_id, seq)
);
