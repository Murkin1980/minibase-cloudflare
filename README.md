# MiniBase

Компактный multi-project BaaS на Cloudflare Workers, D1 и R2.

Статус: MB0/MB1 — архитектурный каркас и control plane. Production deployment
ещё не создан.

## Возможности каркаса

- management API `POST /v1/projects`;
- идемпотентное создание отдельной D1-базы на проект;
- `mb_publishable_*`, `mb_secret_*` и отдельный `mb_management_*`;
- хэширование ключей, scope, отзыв и аудит в управляющей базе;
- применение начальной схемы через Cloudflare D1 API;
- состояния provisioning и безопасный повтор операции.

## Локальная проверка

```bash
npm install
npm run lint
npm run typecheck
npm test
```

Для реального развёртывания скопируйте `wrangler.example.jsonc` в
`wrangler.jsonc`, создайте управляющую D1 и задайте секреты через Wrangler.
Никогда не помещайте Cloudflare API token или management key в Git.

## Management keys

Начиная с MB2, `mb_management_*` проверяются по SHA-256 хэшу в управляющей D1.
Записи содержат scopes, срок действия, время последнего использования, источник
ротации и отметку отзыва. Исходное значение ключа возвращается только один раз.

Для первой локальной инициализации выполните:

```bash
npm run bootstrap:key
```

Команда локально создаёт ключ и печатает SQL с его хэшем. Сохраните сам ключ в
доверенном менеджере секретов, а SQL применяйте только к управляющей D1 после
миграции `0002_management_keys.sql`. Команда ничего не создаёт в Cloudflare.

Management endpoints:

- `POST /v1/management-keys` — выпуск или ротация, scope `keys:write`;
- `DELETE /v1/management-keys/{id}` — отзыв, scope `keys:write`;
- `POST /v1/projects` — provisioning, scope `projects:write`.

## Модель подключения

Клиентское приложение получает только URL API и `mb_publishable_*`.
`mb_secret_*` допустим исключительно в доверенном backend. Создание проекта
выполняется control plane с `mb_management_*`; Cloudflare API token остаётся
секретом Worker.
