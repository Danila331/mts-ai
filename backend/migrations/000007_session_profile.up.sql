-- Профиль собеседника в сессии (T15, T16).
--
-- role — роль-подсказка: кто, вероятно, пишет (business, engineer, housing,
-- grid, mts_manager и сегменты базы из раздела «Навигация по типу
-- компании»). Не шлагбаум: чат работает и без неё. Список ролей проверяет
-- служба (internal/session), а не CHECK: новая роль не должна требовать
-- миграции. Пусто — роль неизвестна.
--
-- role_source — откуда роль: client — клиент выбрал сам (или сам отказался
-- её указывать при пустой role), auto — определена по репликам или по типу
-- организации из паспорта. Пусто — роли не было ни разу.
--
-- level — уровень объяснения «проще / технически» (T16). Колонка общая с
-- T16 и заводится здесь, как закреплено в ROADMAP (раздел 5); значения
-- проверяет T16.
ALTER TABLE sessions ADD COLUMN role        text NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN role_source text NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN level       text NOT NULL DEFAULT '';
ALTER TABLE sessions ADD CONSTRAINT sessions_role_source_known CHECK (role_source IN ('', 'client', 'auto'));
