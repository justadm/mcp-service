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

Шаблон лежит в репо:
- `deploy/nginx/justgpt.ru.conf`

На VM:
```bash
sudo -n cp /opt/mcp-service/deploy/nginx/justgpt.ru.conf /etc/nginx/sites-available/justgpt.ru
sudo -n ln -sf /etc/nginx/sites-available/justgpt.ru /etc/nginx/sites-enabled/justgpt.ru
sudo -n nginx -t
sudo -n systemctl reload nginx
```

На этом этапе `http://app.justgpt.ru/` и `http://api.justgpt.ru/` должны отдавать `200 OK` (без TLS).

## 5) Запросить сертификат Let’s Encrypt

Рекомендуемый способ (минимум “магии” в nginx-конфигах) через `webroot`:
```bash
sudo -n certbot certonly --webroot -w /var/www/letsencrypt \
  -d app.justgpt.ru -d api.justgpt.ru -d mcp.justgpt.ru
```

После успешной выдачи сертификата:
```bash
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

## 6) Добавить новый проект

1. Создай `deploy/projects/<projectId>.yml` с `transport.path: /p/<projectId>/mcp`.
2. Добавь сервис в `deploy/docker-compose.nginx.yml` (новый порт 127.0.0.1:19xxx).
3. Добавь `location = /p/<projectId>/mcp` в nginx конфиг `/etc/nginx/sites-available/justgpt.ru`.
4. Применить:
```bash
docker compose -f deploy/docker-compose.nginx.yml up -d --build
sudo -n nginx -t && sudo -n systemctl reload nginx
```

