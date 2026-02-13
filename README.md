# mcp-service

Проект: запуск MCP-сервера из конфигурации, которая описывает источники структурированных данных.

Сейчас реализованы источники:
- `openapi`: превращает операции из OpenAPI `paths` в MCP tools и проксирует HTTP-запросы.
- `csv`: читает локальный CSV и дает tools для чтения строк и простого фильтра `eq`.
- `json`: читает локальный JSON и дает tools для получения значения по JSON Pointer.
- `postgres`: безопасные инструменты для таблиц Postgres (список таблиц, описание, select с whereEq).
- `mysql`: безопасные инструменты для таблиц MySQL (список таблиц, описание, select с whereEq).

## Быстрый старт

1. Установка зависимостей:
```bash
npm install
```

2. Запуск (stdio транспорт):
```bash
cp examples/mcp-service.example.yml mcp-service.yml
npm run dev
```

3. Запуск (HTTP транспорт):
В `mcp-service.yml`:
```yml
transport:
  type: http
  host: 0.0.0.0
  port: 8080
  path: /mcp
  stateful: true
```
И затем:
```bash
npm run dev
```

4. Запуск в Docker (рекомендуется для изоляции окружения):
```bash
docker compose up --build
```
По умолчанию сервис будет доступен на `http://127.0.0.1:18080/mcp` (чтобы не конфликтовать с другими проектами).

## Деплой (MVP)

Для деплоя смотри:
- `RUNBOOK.md` (Traefik TLS, отдельная VM/edge без занятого `:80/:443`)
- `RUNBOOK_NGINX.md` (если на VM уже есть nginx и другие домены)

## Probe (оценка источников для предварительного расчета)

Команда печатает JSON-отчет с базовыми метриками по источникам из конфига.
```bash
npm run probe
```
Примечание: `postgres` в probe делается best-effort. Если нет доступа к БД, в отчете будет `ok: false` и текст ошибки, а не падение процесса.

Переменная окружения для выбора конфига:
- `MCP_SERVICE_CONFIG=/path/to/file.yml`

## Генерация проекта (init)

Сгенерировать новый проект для managed деплоя (создаст `deploy/projects/<id>.yml`, `deploy/docker-compose.nginx.<id>.yml`,
добавит токен в `deploy/.env.example` и добавит `location = /p/<id>/mcp` в `deploy/nginx/justgpt.ru.https.conf`):

```bash
npm run build
node dist/cli.js init --id myproj --type mysql --mysql-database test_ameton
```

Отключить авто-правки `deploy/.env.example` и nginx-шаблона:
```bash
node dist/cli.js init --id myproj --type mysql --no-update-env-example --no-update-nginx
```

## Пример конфигурации

Смотри `examples/mcp-service.example.yml`.

## Секреты (MVP)

Для `openapi`, `postgres` и `mysql` поддержаны секреты через `*_File` или `*_Env`:
- `openapi.auth.type: bearer`:
  - `token` или `tokenFile` или `tokenEnv`
- `openapi.auth.type: header`:
  - `value` или `valueFile` или `valueEnv`
- `postgres`:
  - `connectionString` или `connectionStringFile` или `connectionStringEnv`
- `mysql`:
  - `connectionString` или `connectionStringFile` или `connectionStringEnv`

## Ограничения текущей реализации

- Для OpenAPI входная схема tools пока унифицированная (`params/query/headers/body`) и не генерируется из OpenAPI schema.
- Для `postgres` намеренно нет “сырого SQL”; только `select` с ограничениями.
- Для `mysql` намеренно нет “сырого SQL”; только `select` с ограничениями.

## Transport auth (HTTP)

Для HTTP транспорта можно включить простую аутентификацию Bearer-токеном (per-project):

```yml
transport:
  type: http
  auth:
    type: bearer
    tokenEnv: MCP_BEARER_TOKEN
```

В этом режиме каждый HTTP запрос к `transport.path` должен содержать заголовок:
`Authorization: Bearer <TOKEN>`.

Если перед `mcp-service` стоит nginx Basic Auth, то использовать `Authorization: Bearer ...` одновременно с Basic нельзя (один заголовок).
В этом случае передавай токен в `X-MCP-Bearer-Token: <TOKEN>` (или `X-Project-Token: <TOKEN>`).

## Smoke-тест (HTTP MCP)

В репозитории есть скрипт `scripts/smoke_http_mcp.sh`:
- делает `initialize`
- делает `tools/list`
- опционально делает `tools/call`

Пример для MySQL-проекта `my` (nginx Basic + per-project token):
```bash
MCP_BASE_URL='https://mcp.justgpt.ru' \
MCP_BASIC_USER='mcp' \
MCP_BASIC_PASS='<ADMIN_PASSWORD>' \
MCP_PROJECT_PATH='/p/my/mcp' \
MCP_PROJECT_TOKEN='<MCP_MY_BEARER_TOKEN>' \
MCP_TOOL_NAME='mysql_mysql_main_list_tables' \
./scripts/smoke_http_mcp.sh
```

Если `MCP_TOOL_ARGS_JSON` неудобно экранировать, можно передать аргументы через файл:
```bash
cat > /tmp/mcp_args.json <<'JSON'
{"pointer":"/meta/source"}
JSON

MCP_BASE_URL='https://mcp.justgpt.ru' \
MCP_BASIC_USER='mcp' \
MCP_BASIC_PASS='<ADMIN_PASSWORD>' \
MCP_PROJECT_PATH='/p/j1/mcp' \
MCP_PROJECT_TOKEN='<MCP_J1_BEARER_TOKEN>' \
MCP_TOOL_NAME='json_json_main_get' \
MCP_TOOL_ARGS_FILE='/tmp/mcp_args.json' \
./scripts/smoke_http_mcp.sh
```
