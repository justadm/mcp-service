# RUNBOOK (MVP деплой на 1 VM, Traefik TLS)

Цель: поднять на одной VM (TimeWeb Cloud server) сервисы `app/api/mcp` через Docker Compose, с TLS через Traefik.

В MVP здесь описан только домен `mcp.justgpt.ru` и path-routing под проекты:
- `https://mcp.justgpt.ru/p/<projectId>/mcp`

## 1) DNS

Заведи A/AAAA записи на публичный IP VM:
- `mcp.justgpt.ru -> <VM_IP>`

Потом можно так же добавить:
- `app.justgpt.ru`
- `api.justgpt.ru`

## 2) Подготовка VM

Нужно установить:
- Docker
- Docker Compose (плагин `docker compose`)

Порты на VM:
- открыть входящие `80/tcp` и `443/tcp`

## 3) Деплой

На VM:
1. Клонировать репозиторий.
2. Перейти в `deploy/`.
3. Создать `.env` из примера:
```bash
cd deploy
cp .env.example .env
```
4. Подготовить ACME storage:
```bash
mkdir -p acme
touch acme/acme.json
chmod 600 acme/acme.json
```
5. Запустить:
```bash
docker compose -f docker-compose.prod.yml up -d --build
```

Проверка:
- Traefik должен получить сертификат Let’s Encrypt на `mcp.justgpt.ru`.
- Заглушки должны отвечать `200` по:
  - `https://app.justgpt.ru/`
  - `https://api.justgpt.ru/`
- Должны отвечать endpoints проектов:
  - `https://mcp.justgpt.ru/p/p1/mcp`
  - `https://mcp.justgpt.ru/p/p2/mcp`

### Быстрая проверка HTTP (health/ready)

```bash
curl -fsS https://mcp.justgpt.ru/health
curl -fsS https://mcp.justgpt.ru/ready
```

### Минимальная ручная проверка MCP через curl

Примечания:
- `Accept` должен включать и `application/json`, и `text/event-stream` (требование спецификации Streamable HTTP).
- после `initialize` сервер вернет заголовок `mcp-session-id`, его надо передавать дальше.
- если включен `transport.auth: bearer`, добавь заголовок `Authorization: Bearer <TOKEN>` (токен per-project).

1) `initialize` (создает сессию):
```bash
curl -i \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'authorization: Bearer <P1_BEARER_TOKEN>' \
  -X POST 'https://mcp.justgpt.ru/p/p1/mcp' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0.0"}}}'
```

2) `tools/list` (подставь `<SESSION_ID>` из `mcp-session-id`):
```bash
curl -i \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-03-26' \
  -H 'mcp-session-id: <SESSION_ID>' \
  -H 'authorization: Bearer <P1_BEARER_TOKEN>' \
  -X POST 'https://mcp.justgpt.ru/p/p1/mcp' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

## 4) Добавление нового проекта

Паттерн “1 проект = 1 контейнер”:
1. Создай конфиг `deploy/projects/<projectId>.yml` по образцу `deploy/projects/p1.yml`.
   Важно: `transport.path` должен быть `/p/<projectId>/mcp`.
2. Добавь новый сервис `mcp_<projectId>` в `deploy/docker-compose.prod.yml` по образцу `mcp_p1`.
3. Применить:
```bash
docker compose -f deploy/docker-compose.prod.yml up -d --build
```

## Примечания/ограничения MVP

- В текущей реализации `mcp-service` проверяет путь на точное совпадение с `transport.path`, поэтому path нужно задавать “как снаружи”, например `/p/p1/mcp`.
- В текущей реализации `StreamableHTTPServerTransport` требует `transport.stateful: true` для долгоживущего HTTP-сервиса (иначе транспорт "одноразовый" и не может обслуживать несколько запросов подряд).
- Секреты (`connectionString`, токены) сейчас просто в YAML. В roadmap есть задача перейти на `*_FILE`/secret manager.
