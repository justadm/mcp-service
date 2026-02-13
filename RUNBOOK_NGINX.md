# RUNBOOK (MVP деплой на 1 VM с существующим nginx, без Traefik)

Сценарий: на VM уже есть nginx и другие домены (например, `devee.ru`), поэтому Traefik с ACME на `:80/:443` не используем.

Цель:
- `app.justgpt.ru` -> 200 заглушка
- `api.justgpt.ru` -> 200 заглушка
- `mcp.justgpt.ru/p/<projectId>/mcp` -> reverse proxy на локальные docker-контейнеры `mcp-service`

## Demo Postgres (тестовые данные)

В репозитории есть demo Postgres с init SQL:
- `deploy/postgres/init/001_demo.sql`

И demo MCP проект:
- `deploy/projects/pg.yml` (endpoint: `/p/pg/mcp`)

## 1) DNS

A/AAAA на IP этой VM:
- `justgpt.ru`
- `www.justgpt.ru`
- `app.justgpt.ru`
- `api.justgpt.ru`
- `mcp.justgpt.ru`

## 2) Поднять MCP контейнеры (локально на VM)

В каталоге репозитория:
```bash
cd /opt/mcp-service   # пример
docker compose -f deploy/docker-compose.nginx.yml up -d --build
```

Контейнеры будут слушать локально:
- `127.0.0.1:19001` (p1)
- `127.0.0.1:19002` (p2)
- `127.0.0.1:19003` (pg, если поднят `deploy/docker-compose.nginx.pg.yml`)
- `127.0.0.1:19004` (tw)

## 3) Подготовить webroot для Let’s Encrypt (HTTP-01)

```bash
sudo -n mkdir -p /var/www/letsencrypt/.well-known/acme-challenge
sudo -n chown -R root:root /var/www/letsencrypt
sudo -n chmod -R 755 /var/www/letsencrypt
```

## 4) Подключить nginx конфиг justgpt.ru (HTTP stub + proxy)

Шаблоны лежат в репо:
- `deploy/nginx/justgpt.ru.http.conf` (80/tcp, ACME + 200 заглушка)
- `deploy/nginx/justgpt.ru.https.conf` (443/tcp, после выпуска сертификата)

На VM:
```bash
sudo -n cp /opt/mcp-service/deploy/nginx/justgpt.ru.http.conf /etc/nginx/sites-available/justgpt.ru.http
sudo -n ln -sf /etc/nginx/sites-available/justgpt.ru.http /etc/nginx/sites-enabled/justgpt.ru.http

sudo -n nginx -t
sudo -n systemctl reload nginx
```

На этом этапе `http://app.justgpt.ru/` и `http://api.justgpt.ru/` должны отдавать `200 OK` (без TLS).

## 5) Запросить сертификат Let’s Encrypt

Рекомендуемый способ (минимум “магии” в nginx-конфигах) через `webroot`:
```bash
sudo -n certbot certonly --webroot -w /var/www/letsencrypt \
  --cert-name justgpt.ru \
  -d justgpt.ru -d www.justgpt.ru -d app.justgpt.ru -d api.justgpt.ru -d mcp.justgpt.ru
```

После успешной выдачи сертификата включи HTTPS-конфиг:
```bash
sudo -n cp /opt/mcp-service/deploy/nginx/justgpt.ru.https.conf /etc/nginx/sites-available/justgpt.ru.https
sudo -n ln -sf /etc/nginx/sites-available/justgpt.ru.https /etc/nginx/sites-enabled/justgpt.ru.https

sudo -n nginx -t
sudo -n systemctl reload nginx
```

## 5.1) Редирект HTTP -> HTTPS

В `deploy/nginx/justgpt.ru.http.conf` настроен 301 редирект на HTTPS (кроме `/.well-known/acme-challenge/`).
После изменения шаблона не забудь обновить файл на VM:
```bash
sudo -n cp /opt/mcp-service/deploy/nginx/justgpt.ru.http.conf /etc/nginx/sites-available/justgpt.ru.http
sudo -n nginx -t && sudo -n systemctl reload nginx
```

### Basic Auth для MCP (MVP)

Создай `htpasswd` файл только для админского Basic Auth (он будет общим и для `/health`/`/ready`, и для всех `/p/<projectId>/mcp`).

Админский (пример: пользователь `mcp`):
```bash
sudo -n htpasswd -c /etc/nginx/.htpasswd-justgpt-mcp mcp
sudo -n chmod 600 /etc/nginx/.htpasswd-justgpt-mcp
sudo -n nginx -t && sudo -n systemctl reload nginx
```

Примечание: per-project аутентификацию делаем внутри `mcp-service` через `transport.auth: bearer` (см. ниже), чтобы не плодить `htpasswd` и иметь токен на проект.

Проверка:
```bash
curl -fsS https://app.justgpt.ru/
curl -fsS https://api.justgpt.ru/
curl -fsS -u mcp:<ADMIN_PASSWORD> https://mcp.justgpt.ru/health
curl -fsS -u mcp:<ADMIN_PASSWORD> https://mcp.justgpt.ru/ready
```

Примечание: в текущей реализации `StreamableHTTPServerTransport` требует `stateful: true` для долгоживущего HTTP-сервиса (иначе транспорт "одноразовый" и не может обслуживать несколько запросов подряд). Поэтому в `deploy/projects/*.yml` используем `transport.stateful: true`.

## Минимальная ручная проверка MCP через curl

Примечания:
- `Accept` должен включать и `application/json`, и `text/event-stream` (требование спецификации Streamable HTTP).
- после `initialize` сервер вернет заголовок `mcp-session-id`, его надо передавать дальше.
- если включен `transport.auth: bearer`, добавь `X-MCP-Bearer-Token: <TOKEN>` (токен per-project).
  Важно: одновременно отправить и Basic Auth, и `Authorization: Bearer ...` нельзя, поэтому для nginx+Basic используется отдельный заголовок.

1) `initialize`:
```bash
curl -i -N --max-time 2 \
  -u mcp:<ADMIN_PASSWORD> \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'x-mcp-bearer-token: <P1_BEARER_TOKEN>' \
  -X POST 'https://mcp.justgpt.ru/p/p1/mcp' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0.0"}}}'
```

2) `tools/list`:
```bash
curl -i -N --max-time 2 \
  -u mcp:<ADMIN_PASSWORD> \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-03-26' \
  -H 'mcp-session-id: <SESSION_ID>' \
  -H 'x-mcp-bearer-token: <P1_BEARER_TOKEN>' \
  -X POST 'https://mcp.justgpt.ru/p/p1/mcp' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

3) `tools/call` (пример для p1, OpenAPI Petstore: getPetById):
```bash
curl -i -N --max-time 2 \
  -u mcp:<ADMIN_PASSWORD> \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-03-26' \
  -H 'mcp-session-id: <SESSION_ID>' \
  -H 'x-mcp-bearer-token: <P1_BEARER_TOKEN>' \
  -X POST 'https://mcp.justgpt.ru/p/p1/mcp' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"openapi_petstore_getPetById","arguments":{"params":{"petId":1}}}}'
```

### Проверка demo Postgres проекта (pg)

```bash
curl -i -N --max-time 2 \
  -u mcp:<ADMIN_PASSWORD> \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'x-mcp-bearer-token: <PG_BEARER_TOKEN>' \
  -X POST 'https://mcp.justgpt.ru/p/pg/mcp' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0.0"}}}'
```

Дальше можно вызвать `tools/list` и `tools/call` (например, `pg_pg_demo_list_tables` / `pg_pg_demo_select`).

Пример: `pg_pg_demo_list_tables`:
```bash
curl -i -N --max-time 2 \
  -u mcp:<ADMIN_PASSWORD> \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-03-26' \
  -H 'mcp-session-id: <SESSION_ID>' \
  -H 'x-mcp-bearer-token: <PG_BEARER_TOKEN>' \
  -X POST 'https://mcp.justgpt.ru/p/pg/mcp' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"pg_pg_demo_list_tables","arguments":{"schema":"public"}}}'
```

Пример: `pg_pg_demo_select` (все paid заказы, лимит 5):
```bash
curl -i -N --max-time 2 \
  -u mcp:<ADMIN_PASSWORD> \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-03-26' \
  -H 'mcp-session-id: <SESSION_ID>' \
  -H 'x-mcp-bearer-token: <PG_BEARER_TOKEN>' \
  -X POST 'https://mcp.justgpt.ru/p/pg/mcp' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"pg_pg_demo_select","arguments":{"table":"public.orders","whereEq":{"status":"paid"},"orderBy":"created_at","orderDir":"desc","limit":5}}}'
```

## 6) Добавить новый проект

1. Создай `deploy/projects/<projectId>.yml` с `transport.path: /p/<projectId>/mcp`.
2. Добавь сервис в `deploy/docker-compose.nginx.yml` (новый порт 127.0.0.1:19xxx).
3. Сгенерируй per-project token и пропиши в `deploy/.env` на VM:
   - переменная: `MCP_<PROJECTID>_BEARER_TOKEN=<random>`
   - в compose сервиса прокинь в контейнер:
     - `MCP_BEARER_TOKEN: ${MCP_<PROJECTID>_BEARER_TOKEN}`
4. Добавь `location = /p/<projectId>/mcp` в nginx конфиг `/etc/nginx/sites-available/justgpt.ru.https` (server `mcp.justgpt.ru`).
5. Применить:
```bash
docker compose -f deploy/docker-compose.nginx.yml up -d --build
sudo -n nginx -t && sudo -n systemctl reload nginx
```

Примечание по аутентификации:
- nginx: общий Basic Auth (`mcp:<ADMIN_PASSWORD>`)
- mcp-service: per-project Bearer через `transport.auth: bearer` (передавать `X-MCP-Bearer-Token: <TOKEN>`).
