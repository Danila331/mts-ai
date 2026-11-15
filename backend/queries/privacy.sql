-- Срок хранения и удаление по запросу (internal/privacy).

-- Очистку по сроку делает одна реплика: блокировка живёт до конца
-- транзакции, вторая реплика её не получит и пропустит проход.
-- name: TryRetentionLock :one
SELECT pg_try_advisory_xact_lock(hashtext('energytool:retention'))::boolean AS locked;

-- name: PurgeAnswers :execrows
DELETE FROM answers WHERE created_at < $1;

-- name: PurgeLeads :execrows
DELETE FROM leads WHERE created_at < $1;

-- name: PurgeFeedback :execrows
DELETE FROM feedback WHERE created_at < $1;

-- Удаление по запросу субъекта. Телефон сравнивается по последним десяти
-- цифрам: «8 900…» и «+7 (900)…» — один номер.
-- name: ForgetLeadsByPhone :execrows
DELETE FROM leads WHERE right(regexp_replace(phone, '\D', '', 'g'), 10) = @phone10::text;

-- name: ForgetLeadByCode :execrows
DELETE FROM leads WHERE code = @code::text;

-- Номер, продиктованный в чате, лежит в тексте вопросов и оценок.
-- name: ForgetAnswersMentioning :execrows
DELETE FROM answers WHERE regexp_replace(question || ' ' || answer, '\D', '', 'g') LIKE '%' || @phone10::text || '%';

-- name: ForgetFeedbackMentioning :execrows
DELETE FROM feedback
WHERE regexp_replace(question || ' ' || answer || ' ' || comment, '\D', '', 'g') LIKE '%' || @phone10::text || '%';

-- name: ForgetLeadsMentioning :execrows
DELETE FROM leads WHERE regexp_replace(comment || ' ' || messages::text, '\D', '', 'g') LIKE '%' || @phone10::text || '%';
