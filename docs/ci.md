# CI: проверки кода и ворота релиза

## Что запускается

| workflow | когда | что делает | секреты |
|---|---|---|---|
| `ci.yml` | каждый PR, пуш в `dev`/`main` | `ruff`, все тесты, детерминированная сверка ZIP с регламентом (`scripts/check_submission.py`), `actionlint` для самих workflow; TypeScript (`npm ci`, `lint`, `tsc --noEmit`, `test`) — как только появится `web/package.json` | не нужны |
| `release-gate.yml` | только PR `dev` → `main` и ручной запуск | 1) сверка ZIP с регламентом; 2) **Codex** сверяет ZIP с `docs/tech-regulations.md`; 3) ответы бота на 518 вопросах (500 кейсов + 18 демо) на `qwen/qwen3.8-27b`; 4) **Codex** — слепой судья по методике платформы против бейзлайна из кэша; 5) Score комментарием в PR | `OPENROUTER_API_KEY`, `CODEX_AUTH_JSON`, `CODEX_SECRETS_TOKEN` |

Ворота релиза не дают выпустить в `main` сабмит, который не заработает на лидерборде:
детерминированная сверка ловит формальные нарушения (состав архива, зависимости вне набора жюри,
запуск в чистом окружении, формат `submission.csv`), а Codex читает регламент целиком и ищет то,
что скриптом не формализовать. Нарушение уровня `blocker` роняет задание.

Время: ответы бота ~6–8 мин; судья — 12 пакетов по ~86 записей последовательно, ориентировочно
30–90 мин в зависимости от модели и лимитов подписки. Workflow перезапускается на каждый новый
коммит в открытом PR `dev → main`, поэтому такой PR лучше открывать, когда `dev` готов к релизу.
Ручной запуск: Actions → *Release gate* → *Run workflow* (можно выбрать набор `demo` для быстрой проверки).

## 1. Секреты репозитория

Settings → Secrets and variables → Actions, или из терминала (`gh` должен быть авторизован):

```bash
gh secret set OPENROUTER_API_KEY --repo Danila331/mts-ai
```

Команда спросит значение — вставьте ключ OpenRouter (генерация `qwen/qwen3.8-27b` и эмбеддинги `bge-m3`).

| секрет | зачем |
|---|---|
| `OPENROUTER_API_KEY` | ответы бота на выборке |
| `CODEX_AUTH_JSON` | вход Codex по подписке ChatGPT (раздел 2) |
| `CODEX_SECRETS_TOKEN` | сохранять обновлённый `auth.json` обратно в секрет (раздел 2, шаг 5) |
| `OPENAI_API_KEY` | необязательно: вместо подписки — обычный API-ключ OpenAI; если задан, используется он |

Необязательные переменные (вкладка *Variables*): `CODEX_MODEL` — модель Codex (по умолчанию — модель
подписки), `EVAL_MIN_SCORE` — порог Score, ниже которого задание падает (например `0.80`).

## 2. Вход Codex по подписке ChatGPT

Официальная схема: [Maintain Codex account auth in CI/CD](https://developers.openai.com/codex/auth/ci-cd-auth).
OpenAI называет её «продвинутой» и рекомендует для CI API-ключи; вход по подписке допустим для
приватных репозиториев (наш — приватный). Использование в CI расходует лимиты вашей подписки.

1. Поставьте Codex CLI:

   ```bash
   npm install -g @openai/codex
   ```

2. Заведите **отдельную папку** для CI-входа, чтобы ноутбук и CI не перебивали друг другу токены,
   и включите хранение в файле:

   ```bash
   mkdir -p ~/.codex-ci && printf 'cli_auth_credentials_store = "file"\n' > ~/.codex-ci/config.toml
   ```

3. Войдите через ChatGPT (откроется браузер):

   ```bash
   CODEX_HOME=~/.codex-ci codex login
   ```

   На машине без браузера — `codex login --device-auth` (сначала включите вход по коду устройства
   в настройках безопасности ChatGPT).

4. Проверьте, что это вход именно по подписке (`auth_mode` должен быть `chatgpt`), и загрузите файл в секрет:

   ```bash
   python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.codex-ci/auth.json')))['auth_mode'])"
   ```

   ```bash
   gh secret set CODEX_AUTH_JSON --repo Danila331/mts-ai < ~/.codex-ci/auth.json
   ```

   После этого не запускайте Codex с `CODEX_HOME=~/.codex-ci` локально: этот вход теперь принадлежит CI.

5. Токен для сохранения обновлённого `auth.json`. Codex сам обновляет токены (примерно раз в 8 дней)
   и пишет новый `auth.json`; на одноразовом раннере его нужно сохранить обратно, иначе вход протухнет.
   GitHub → Settings → Developer settings → Fine-grained tokens → *Generate new token*:
   доступ только к репозиторию `Danila331/mts-ai`, права *Secrets: Read and write*. Затем:

   ```bash
   gh secret set CODEX_SECRETS_TOKEN --repo Danila331/mts-ai
   ```

Правила безопасности: `auth.json` — как пароль (в нём токены доступа). Не коммитьте его, не выводите в
логи, не кладите в артефакты. Задания с Codex в workflow идут строго по очереди (общий `concurrency`),
потому что один `auth.json` нельзя использовать в параллельных заданиях. Если вход перестал работать
(`401`, «refresh token…»), повторите шаги 3–4.

## 3. Защита `main`: ревью другого человека, админ может выпустить сам

Это настройка безопасности репозитория — её меняет владелец, не ИИ-агент (см. `AGENTS.md`).

Settings → Branches → правило для `main` (или *Add branch protection rule*, шаблон `main`):

- ✅ **Require a pull request before merging** → ✅ **Require approvals**: `1` → ✅ *Dismiss stale pull
  request approvals when new commits are pushed*;
- ✅ **Require status checks to pass before merging** → добавьте проверки (появятся в поиске после
  первого запуска workflow): `Python — линтер, тесты, сабмит`, `Сабмит — сверка с регламентом`,
  `Codex — ZIP против технического регламента`;
- ⬜ **Do not allow bypassing the above settings** — **снять**: тогда администратор при слиянии видит
  галочку *Merge without waiting for requirements to be met (bypass branch protections)*, а остальным
  нужен апрув другого человека;
- force push и удаление ветки — запрещены (по умолчанию).

То же одной командой (выполняет владелец репозитория):

```bash
gh api -X PUT repos/Danila331/mts-ai/branches/main/protection --input - <<'EOF'
{
  "required_status_checks": {"strict": false, "contexts": [
    "Python — линтер, тесты, сабмит",
    "Сабмит — сверка с регламентом",
    "Codex — ZIP против технического регламента"
  ]},
  "enforce_admins": false,
  "required_pull_request_reviews": {"required_approving_review_count": 1, "dismiss_stale_reviews": true},
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
EOF
```

`enforce_admins: false` и есть «админ может выпустить сам»: правила действуют для всех, кроме администраторов.

## 4. Локально — то же самое без GitHub

```bash
.venv/bin/ruff check .
.venv/bin/python -m unittest discover -s tests
.venv/bin/python scripts/check_submission.py
.venv/bin/python eval/run_eval.py --set all --baseline-pred eval/baseline/answers.csv --no-judge
.venv/bin/python eval/blind_judge.py export eval/reports/<время> --baseline-pred eval/baseline/answers.csv
```

Зависимости для разработки и CI — `requirements-dev.txt` (решение по-прежнему использует только
`solution-requirements.txt`, сверяемый с набором жюри).
