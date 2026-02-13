# RUNBOOK (MVP деплой на 1 VM с существующим nginx, без Traefik)

Сценарий: на VM уже есть nginx и другие домены (например, `devee.ru`), поэтому Traefik с ACME на `:80/:443` не используем.

Цель:
- `app.justgpt.ru` -> 200 заглушка
- `api.justgpt.ru` -> 200 заглушка
- `mcp.justgpt.ru/p/<projectId>/mcp` -> reverse proxy на локальные docker-контейнеры `mcp-service`

## 1) DNS

A/AAAA на IP этой VM:
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
  -d app.justgpt.ru -d api.justgpt.ru -d mcp.justgpt.ru
```

После успешной выдачи сертификата включи HTTPS-конфиг:
```bash
sudo -n cp /opt/mcp-service/deploy/nginx/justgpt.ru.https.conf /etc/nginx/sites-available/justgpt.ru.https
sudo -n ln -sf /etc/nginx/sites-available/justgpt.ru.https /etc/nginx/sites-enabled/justgpt.ru.https

sudo -n nginx -t
sudo -n systemctl reload nginx
```

Проверка:
```bash
curl -fsS https://app.justgpt.ru/
curl -fsS https://api.justgpt.ru/
curl -fsS https://mcp.justgpt.ru/health
curl -fsS https://mcp.justgpt.ru/ready
```

## Минимальная ручная проверка MCP через curl

Примечания:
- ответ идет через SSE, поэтому `curl` будет “висеть”; добавляй `--max-time 2`.
- после `initialize` сервер вернет заголовок `mcp-session-id`, его надо передавать дальше.

1) `initialize`:
```bash
curl -i -N --max-time 2 \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -X POST 'https://mcp.justgpt.ru/p/p1/mcp' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0.0"}}}'
```

2) `tools/list`:
```bash
curl -i -N --max-time 2 \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-03-26' \
  -H 'mcp-session-id: <SESSION_ID>' \
  -X POST 'https://mcp.justgpt.ru/p/p1/mcp' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

## 6) Добавить новый проект

1. Создай `deploy/projects/<projectId>.yml` с `transport.path: /p/<projectId>/mcp`.
2. Добавь сервис в `deploy/docker-compose.nginx.yml` (новый порт 127.0.0.1:19xxx).
3. Добавь `location = /p/<projectId>/mcp` в nginx конфиг `/etc/nginx/sites-available/justgpt.ru`.
4. Применить:
```bash
docker compose -f deploy/docker-compose.nginx.yml up -d --build
sudo -n nginx -t && sudo -n systemctl reload nginx
```
