# MiniBase

Компактный multi-project BaaS на Cloudflare Workers, D1 и R2.

Статус: внутренняя BaaS-инфраструктура развёрнута; подключение первого пилотного
проекта остаётся отдельной итерацией.

## Возможности каркаса

- management API `POST /v1/projects`;
- идемпотентное создание отдельной D1-базы на проект;
- `mb_publishable_*`, `mb_secret_*` и отдельный `mb_management_*`;
- хэширование ключей, scope, отзыв и аудит в управляющей базе;
- применение начальной схемы через Cloudflare D1 API;
- состояния provisioning и безопасный повтор операции;
- курсорная пагинация с однозначным `hasMore`;
- настраиваемые лимиты запросов с жёсткими максимумами;
- аудит с `entity`, `entity_id` и `correlation_id`;
- per-project квоты, которые могут только сужать лимиты деплоя;
- отдельные rate-периоды для control, data и files, плюс отдельный rate-bucket
  на проект;
- fail-closed поведение при отсутствующем или повреждённом project context.

Архитектура описана в [ARCHITECTURE.md](ARCHITECTURE.md). Аудит масштабируемости,
риски и план checkpoint'ов — в [docs/SCALABILITY.md](docs/SCALABILITY.md).
Контракт изоляции проектов для потребителей — в
[docs/PROJECT_ISOLATION.md](docs/PROJECT_ISOLATION.md).

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

Списки используют keyset-пагинацию: `limit` и `after`, а признак конца —
поле `hasMore`. `nextAfter` сохраняется для совместимости, но продолжать
обход следует по `hasMore`.

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

### Project quotas

Каждый потолок запросов можно дополнительно сузить для отдельного проекта — без
нового деплоя:

```http
GET /v1/projects/{projectId}/quotas
PUT /v1/projects/{projectId}/quotas
Authorization: Bearer mb_management_...
Content-Type: application/json

{"maxJsonBytes":8192,"maxPageSize":25}
```

Ответ разделяет `configured` (что сохранено, `null` = наследовать потолок деплоя)
и `effective` (что Worker реально применит). Квота может только **сужать**
потолок деплоя и никогда не может его расширить — ни через endpoint, ни прямой
правкой control D1: некорректное значение игнорируется. `PUT` заменяет весь
набор, поэтому повтор того же тела идемпотентен. Scope — `projects:write`.

Превышение квоты возвращает уже известные коды: 413 `request_body_too_large`,
413 `file_too_large`, 400 `invalid_limit`. Новых кодов ошибок квоты не добавляют.

Квоты читаются тем же `api_keys JOIN projects`-запросом, который аутентифицирует
ключ, поэтому не добавляют ни одного обращения к control D1 на горячем пути.

## Модель подключения

Клиентское приложение получает только URL API и read-only `mb_publishable_*`.
Запись данных и файлов разрешена только доверенному backend с `mb_secret_*`;
до появления пользовательской Auth и row-level authorization браузерные
write-scopes намеренно запрещены.
`mb_secret_*` допустим исключительно в доверенном backend. Создание проекта
выполняется control plane с `mb_management_*`; Cloudflare API token остаётся
секретом Worker.
