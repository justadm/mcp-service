# mcp-service

Проект: запуск MCP-сервера из конфигурации, которая описывает источники структурированных данных.

Сейчас реализованы источники:
- `openapi`: превращает операции из OpenAPI `paths` в MCP tools и проксирует HTTP-запросы.
- `csv`: читает локальный CSV и дает tools для чтения строк и простого фильтра `eq`.
- `json`: читает локальный JSON и дает tools для получения значения по JSON Pointer.
- `postgres`: безопасные инструменты для таблиц Postgres (список таблиц, описание, select с whereEq).

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

## Пример конфигурации

Смотри `examples/mcp-service.example.yml`.

## Ограничения текущей реализации

- Для OpenAPI входная схема tools пока унифицированная (`params/query/headers/body`) и не генерируется из OpenAPI schema.
- Для `postgres` намеренно нет “сырого SQL”; только `select` с ограничениями.
