# MiniBase

## Access-backed user sessions

Закрытые приложения могут обменять project-scoped `mb_publishable_*` key и проверенный Cloudflare Access JWT на восьмичасовую `mb_session_*` сессию:

```http
POST /v1/sessions/exchange
Authorization: Bearer mb_publishable_...
Cf-Access-Jwt-Assertion: <injected by Cloudflare Access>
```

Worker проверяет RS256 signature, issuer, audience, expiry и subject по официальным Access JWK. Raw subject и raw session token не сохраняются: control D1 получает только project-bound SHA-256 subject hash и token hash. Records и files session principal автоматически изолируются этим hash. `DELETE /v1/sessions/current` отзывает текущую сессию.

Этот режим требует, чтобы MiniBase Worker был защищён тем же Cloudflare Access application boundary. Заголовок identity нельзя принимать без криптографической проверки.

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
- `GET /v1/audit-events?limit=50&before=<ISO-8601>` — журнал аудита,
  scope `audit:read`.

JSON request bodies ограничены 64 KiB и должны иметь
`Content-Type: application/json`.

Provisioning привязывает `Idempotency-Key` к хэшу нормализованного запроса.
Повтор с тем же ключом и другим телом отклоняется. Резервирование проекта и
provisioning job выполняется атомарным D1 batch. Если удалённая D1 уже создана,
но последующий шаг завершился ошибкой, control plane пытается удалить её и
записывает `rollback_status` в job и audit log.

Ошибки API имеют единый безопасный формат:

```json
{ "error": { "code": "invalid_slug" } }
```

Неизвестные исключения и ответы Cloudflare не возвращаются клиенту дословно.

## Records data API

Data keys выбирают проект только через хэш в control D1. Клиент не передаёт
database ID и никогда не получает Cloudflare token.

- `GET /v1/data/{collection}` — список до 100 записей (`data:read`);
- `GET /v1/data/{collection}/{id}` — одна запись (`data:read`);
- `PUT /v1/data/{collection}/{id}` — upsert JSON-объекта (`data:write`);
- `DELETE /v1/data/{collection}/{id}` — удаление (`data:write`).

Collection и record ID проходят allowlist-валидацию, а SQL и database UUID не
принимаются из публичного request body.

### Browser origins

Management API настраивает allowlist проекта:

```http
PUT /v1/projects/{projectId}/origins
Authorization: Bearer mb_management_...
Content-Type: application/json

{"origins":["https://tutor.example","http://localhost:3000"]}
```

Произвольный HTTPS origin не отражается в фактическом data response: после
аутентификации ключа Worker сверяет origin с его проектом. HTTP разрешён только
для `localhost` и `127.0.0.1`.

## Модель подключения

Клиентское приложение получает только URL API и `mb_publishable_*`.
`mb_secret_*` допустим исключительно в доверенном backend. Создание проекта
выполняется control plane с `mb_management_*`; Cloudflare API token остаётся
секретом Worker.
