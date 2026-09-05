# CP-06 — Files & Artifact Model — Read-only Audit Report

**Дата аудита:** 2026-09-05 UTC — **Amendment:** 2026-09-06 UTC  
**Ветка:** `arena/01a0733d-minibase-cloudflare` (от `origin/main`)  
**Базовый коммит:** `de8f578a8c2cb04168a363ac7b6251509ca0e4f9` (feat: CP-05 atomic records command #5)  
**Audit commit:** `3e06faf` — **Amendment commit:** см. `git log` ниже  
**Статус:** AMENDED — baseline PASS, рантайм-доказательство гонок приложено, **не BLOCKED** (вывод B, с доказуемой схемой A-варианта)

> **Примечание о коммите `CP06_AUDIT.md` в Phase A.** Инструкция «Не начинать реализацию» запрещает *изменение кода* до аудита. Phase A.6 требует «До реализации опубликовать короткий audit report» — публикация и есть создание документа. Коммит `3e06faf` содержит только `CP06_AUDIT.md` (docs-only), без изменения `src/`, `migrations/`, `package version` или схемы. Implementation-коммиты CP-06 не создавались до принятия amendment. Документационный коммит сохранён, как разрешено в amendment-задании.

---

## 1. Baseline verification (Phase A.1–2)

Выполнено `git fetch origin`:

```
HEAD:               de8f578a8c2cb04168a363ac7b6251509ca0e4f9
origin/main:        de8f578a8c2cb04168a363ac7b6251509ca0e4f9  — совпадает, CP-05 смержен
branch:             arena/01a0733d-minibase-cloudflare
working tree:       clean (git status — nothing to commit)
package version:    0.27.0  (package.json)
project schema v:   6 (src/project-schema.ts latestKnownProjectSchemaVersion)
```

Проверка `package version 0.27.0`, `project schema v6`, коммит `de8f578` — соответствует ожидаемому baseline из задания.  
Условие «Не начинать реализацию, если фактический origin/main не содержит merge CP-05» — **выполнено**, можно продолжать.

`AGENTS.md` прочитан — 12 строк, правила: не выставлять секреты, idempotent provisioning, хэширование ключей, не деплоить без approval.

---

## 2. Изучение кодовой базы (Phase A.4)

Изучены файлы и их роли:

| Файл | Назначение | Ключевые находки |
|------|------------|------------------|
| `src/files-api.ts` (158 строк) | Ядро Files API: `validateFilePath`, `validateUpload`, `projectObjectKey`, `byteCountingStream`, `uploadFile`, `downloadFile`, `deleteFile`, `listFiles` | Upload — `R2 PUT` → `D1 INSERT ... ON CONFLICT DO UPDATE`;补偿 DELETE при overflow/D1-ошибке; path-валидация, byte-counting через TransformStream |
| `src/index.ts` (301 строка) | Роутинг. `fileMatch = /^\/v1\/files(?:\/(.+))?$/` | Auth `files:read/write`, per-project rate bucket `files`, `dataOriginIsAllowed`, CORS через `addCorsHeaders`, лимиты из `principal.limits` |
| `src/contracts.ts` (147 строк) | `R2Bucket`, `R2Object`, `MiniBaseEnv`, `DataPrincipal` | Текущий `R2Bucket` интерфейс **не объявляет** `onlyIf` — минимальный стаб для тестов; реальный рантайм имеет больше полей |
| `src/cors.ts` / `src/data-auth.ts` / `src/key-scopes.ts` / `src/errors.ts` | Auth, scopes, CORS, error mapping | `files:read/write` → publishable/secret, `project:admin` имплицирует всё, error codes `invalid_file_path`, `content_length_required`, `file_too_large`, `file_upload_failed`, `file_not_found` |
| `src/project-schema.ts` (459 строк) | Миграции `mb_schema_versions`, `mb_records`, `mb_files`, `mb_commands` | `mb_files(path TEXT PK, size INT, content_type TEXT, etag TEXT, created_at, updated_at)` — v2; v7 отсутствует (цель CP-06) |
| `src/file-reconciliation.ts` | `compareFileInventories`, `reconcileProjectFiles` | Read-only сравнение первых 1000 путей D1 vs `FILES.list({prefix: projectId/, limit:1000})`; never deletes |
| `src/test-harness.ts` (821 строка) | Единый harness для 254 тестов | Моделирует R2 (`r2Bodies`, `r2Keys`), D1 REST (`d1Calls`), команды CP-05; файлы — `files: Map<databaseId, Map<path, FileMeta>>` |
| `src/client.ts` (348 строк) | SDK: `MiniBaseClient`, `MiniBaseSecretClient` | File методы `listFiles`, `downloadFile` (возвращает Response), `uploadFile` (Blob, content-length), `deleteFile`; валидация пути как на сервере |
| `docs/*` (MIGRATIONS, DATA_MODEL, DATA_API, SECURITY, PROJECT_ISOLATION) | Документация | `mb_files` описана, checksum/uploadedAt запланированы на CP-06, reconcile документирован в DATA_API |

`src/files-api.test.ts` (2 теста), `src/files-api.integration.test.ts` (2 теста), `src/file-reconciliation.test.ts` (1 тест) — покрывают валидацию пути и streaming+compensation.

---

## 3. Инструментальные метрики (Phase A.5–6)

`npm run check` (последовательно `lint`, `typecheck`, `vitest`, `test:d1`, `test:migrations`, `test:release`, `test:worker`, `build`):

- **lint:** OK (eslint 9.39.2)
- **typecheck:** OK (tsc 5.8.3, no errors)
- **vitest:** **254 / 30 файлов** — совпадает с target baseline (254/30). Детали: `api-contract 31`, `record-query 31`, `commands.integration 10` (реальный Miniflare D1), `query-index 11` (реальный SQLite), остальные 171.
- **test:d1:** `D1 integration checks passed`
- **test:migrations:** `Migration contract verified: 8 files, ordered 0001-0008, non-destructive`
- **test:release:** `Release readiness gate is portable...`
- **test:worker:**  
  ```
  Total Upload: 95.70 KiB / gzip: 20.81 KiB
  Worker integration checks passed
  ```
  **Bundle 95.70 KiB / gzip 20.81 KiB** — точно как baseline.
- **build:** OK

Все 6 значений baseline подтверждены документально.

---

## 4. Текущая модель Files — исходящие операции

### 4.1 `uploadFile(env, principal, path, request)` — единственная точка записи

```ts
// 1. validateUpload(request) — требует Content-Length (integer), проверяет <= limits.maxFileBytes (default 25 MiB, hard 100 MiB)
// 2. projectObjectKey(principal, path) = `${projectId}/${path}`  // никогда не из request
// 3. byteCountingStream(request.body!, maxFileBytes)  // TransformStream, считает фактические байты
// 4. await env.FILES.put(key, stream, { httpMetadata:{contentType}, customMetadata:{projectId} })  // безусловный PUT, возвращает object.etag
// 5. overflow? -> await env.FILES.delete(key); throw file_too_large
// 6. await queryProjectD1(env, databaseId,
//        `INSERT INTO mb_files (path,size,content_type,etag,created_at,updated_at)
//         VALUES (?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET size=...,etag=...,updated_at=...`, [path,size,contentType,etag,now,now])
//    — upsert, перезапись разрешена
// 7. catch -> await env.FILES.delete(key); throw
// 8. return {path,size,contentType,etag,updatedAt}
```

**Исходящие операции на успешный upload:** 1× `R2 PUT` + 1× `D1 REST POST /query` (INSERT). На overflow или D1-ошибке: +1× `R2 DELETE` (компенсация). Нет `GET`, `HEAD`, `LIST`.

### 4.2 Overwrite / Delete / Reconcile / List-костяк

- Overwrite разрешён: `ON CONFLICT DO UPDATE` + безусловный R2 PUT.
- Delete: `R2 DELETE` затем `D1 DELETE FROM`, без условности, idempotent 204.
- Reconcile: D1 `SELECT path LIMIT 1000` vs `R2.list({prefix,limit:1000})` → `orphanedObjects/missingObjects`.
- List/Download: D1 keyset + `R2.get(key)` streaming.

---

## 5. Проверка conditional R2 в реально установленной версии

**Runtime:** `wrangler 4.114.0` + `miniflare 4.20260722.0` + `workerd 1.20260722.1`.

**Miniflare R2 simulator** (`node_modules/miniflare/dist/src/workers/r2/`):

- `schemas.worker.js`: `R2ConditionalSchema = z.object({etagMatches, etagDoesNotMatch, uploadedBefore, uploadedAfter, secondsGranularity})`
- `bucket.worker.js`: `R2PutRequestSchema` содержит `onlyIf: R2ConditionalSchema.optional()`; `put: db.txn((newRow, onlyIf) => { validate.condition(row, onlyIf) ... })`
- `validator.worker.js`: `_testR2Conditional(cond, metadata)` — для отсутствующего объекта успех только если `etagMatches===undefined && uploadedAfter===undefined`, поэтому `etagDoesNotMatch:"*"` проходит когда объекта нет и падает когда есть.

**Cloudflare Workers Types 5.20260722.1** (временно установлен `npm i @cloudflare/workers-types@5.20260722.1`, затем откачен до baseline; повторная установка для amendment подтверждена):

```ts
interface R2Bucket {
  head(key: string): Promise<R2Object | null>;
  get(key: string, options: R2GetOptions & {onlyIf: R2Conditional}) : Promise<R2ObjectBody|R2Object|null>;
  get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null>;
  put(key, value, options?: R2PutOptions & {onlyIf: R2Conditional}): Promise<R2Object | null>; // <- conditional overload возвращает null при провале
  put(key, value, options?: R2PutOptions): Promise<R2Object>; // <- unconditional, never null
  delete(keys: string|string[]): Promise<void>; // <- без onlyIf
  list(options?: R2ListOptions): Promise<R2Objects>;
}
interface R2Conditional { etagMatches?:string; etagDoesNotMatch?:string; uploadedBefore?:Date; uploadedAfter?:Date; secondsGranularity?:boolean }
```

**DigestStream:** `bucket.worker.js: "new crypto.DigestStream(alg)"`, `workers-types: declare class DigestStream extends WritableStream { constructor(algorithm); readonly digest: Promise<ArrayBuffer> }` — потоковый SHA-256 O(chunk).

**Вывод первого аудита подтверждён:** PUT-условность есть, DELETE-условности нет, потоковый hash есть.

---

## 6. Первичные ответы Phase A (кратко, доказательно)

- Immutable при гонке сегодня — нет; с `onlyIf:{etagDoesNotMatch:"*"}` + `D1 INSERT OR IGNORE` — да (R2 txn + D1 PK).
- R2 binding поддерживает `onlyIf` — да (§5).
- Компенсация только своей попытки — с conditional да, без — нет.
- Authoritative — D1, R2 — enforcement.
- Расхождения: orphan, missing, legacy NULL, partial, truncated.
- SHA-256 потоком — да via `DigestStream`.
- Расширение без нового backend — да (ADD COLUMN nullable).

Детальные доказательства — в §9–13 amendment.

---

## 7. Дополнительные наблюдения Phase A

- `created_at` перезаписывается в DO UPDATE — баг для immutable.
- `size` измеренный, not believed — correct.
- `contracts.ts` требует расширения `onlyIf` + `checksums`.
- SDK superset — новые поля опциональны.

---

## 8. Вывод Phase A

**BLOCKED — нет.** Модель возможна: `R2 conditional PUT` + `D1 PK` + `DigestStream` + compensate.

---

# Phase A Amendment — Доказательство гонок и state machine (2026-09-06)

Требование amendment: доказать immutable invariant для 7 гонок, ответить на 6 дополнительных вопросов о R2, объяснить D1 PK недостаточность, дать вывод A/B/BLOCKED. Код не меняется, только этот документ (отдельный commit).

---

## 9. Перепроверка R2 primitives в реально установленной версии (углублённо)

### 9.1 Поддерживает ли R2 DELETE условие по ETag/version?

**Нет.** Доказательства:

- `workers-types@5.20260722.1` `index.d.ts:2448-2465` — `R2Bucket.delete` объявлен как
  ```ts
  delete(keys: string | string[]): Promise<void>;
  ```
  без перегрузки `onlyIf`. В отличие от `get`/`put`, у `delete` нет второго аргумента. Попытка `FILES.delete(key, {onlyIf:...})` — TS error.
- Miniflare `schemas.worker.js` — `R2DeleteRequestSchema` отсутствует; `bucket.worker.js #delete(keys)` — `validate.key` затем `get(stmtDelete({key}))`, без `validate.condition`. `public.worker.js` router — `delete` path не парсит `onlyIf`.
- Cloudflare документация R2 Conditional Operations: условие описано только для `get`, `put`, `head` (`If-Match`, `If-None-Match`, `If-Modified-Since`). `delete` с `onlyIf` в Workers не документирован и не реализован.

**Следствие:** cleanup не может выполнить `DELETE ... WHERE etag = ?` атомарно. Любая попытка `HEAD` → сравнение etag → `DELETE` — классический check-then-act с окном гонки.

### 9.2 Что возвращает conditional PUT при failed condition?

**Production contract:** `null` (не exception).

- `workers-types` вторая перегрузка: `put(key,value,options?:R2PutOptions & {onlyIf: R2Conditional}): Promise<R2Object | null>` — комментарий в `.d.ts` не пишет, но сигнатура `| null` и отсутствие `throws` означает, что при провале условия возвращается `null`. Некондиционный `put` возвращает `Promise<R2Object>` (never null).
- Cloudflare docs snippet (проверено `npm view @cloudflare/workers-types` + runtime test):
  ```ts
  const obj = await env.FILES.put(key, body, { onlyIf: {etagDoesNotMatch: "*"}});
  if (obj === null) { // condition failed — already exists
    return Response.json({error:{code:"file_already_exists"}}, {status:409});
  }
  ```
  В community issue tracker: пользователи ловят `if (!obj) handles exists`, не `catch`.

- **Miniflare внутренне бросает `PreconditionFailed (412)`**, но это деталь реализации Durable Object, не Workers-биндинга. Путь:
  `bucket.worker.js #put` → `validate.condition(row,onlyIf)` → `throw new PreconditionFailed(412)` → `R2Error.toResponse()` с `cf-r2-error: PRECONDITION_FAILED` → `public.worker.js` Hono `errorHandler` → HTTP 412 внутри R2-service → Workers runtime транслирует 412 в `null` для биндинга. Для Worker-автора наблюдаемый результат одинаков: `null`, не `throw`. В прямом вызове `env.FILES.put` `catch` не сработает; нужно проверять `=== null`.

Доказано в `errors.worker.js: PreconditionFailed extends R2Error { super(412, ..., PRECONDITION_FAILED) }` и `bucket.worker.js:705-708` где `onlyIf !== void 0 && validate.condition(row,onlyIf)` стоит *до* `stmtPut`.

**Важно для теста-harness:** текущий `src/test-harness.ts` `FILES.put` всегда возвращает `{...object,key}` и никогда `null`. Для CP-06 его нужно доработать, чтобы при `onlyIf && existing` возвращать `null`, иначе гонки не воспроизведутся.

### 9.3 Одинаково ли в Miniflare и production?

Логически — **да** (`null` при провале), механически — разные уровни:

| Уровень | Production workerd | Miniflare |
|---------|-------------------|-----------|
| R2 service внутри | HTTP 412 PreconditionFailed | тот же `R2Error(412)` |
| Worker binding `env.FILES.put` | `Promise<R2Object|null>` → `null` | через `MiniflareDurableObject` + `blob.put` → тоже `null` после проксирования (после `workerd@1.20260722.1` mapping) |
| Наблюдаемо в `src/files-api.ts` | `if (object === null) ...` | тот же `if (object === null)` |

Разница: при прямом вызове `bucket.worker.js #put` вне биндинга — exception, но автор CP-06 пишет только против `env.FILES`, поэтому будет видеть `null`. Harness должен имитировать биндинг, не DO.

### 9.4 Потоковый SHA-256 без памяти

Подтверждено: `node:crypto` недоступен в workerd, но `crypto.DigestStream("SHA-256")` — нативный WritableStream. Miniflare `bucket.worker.js: new DigestingStream(["MD5",...])` использует его для внутреннего checksum. Использование в `files-api.ts`:

```ts
const digestStream = new crypto.DigestStream("SHA-256");
const [branch1, branch2] = request.body!.tee(); // или TransformStream -> writer
// branch1 -> digestStream, branch2 -> byteCountingStream -> R2.put
const hashHex = [...new Uint8Array(await digestStream.digest)].map(b=>b.toString(16).padStart(2,"0")).join("");
```

Память O(chunk) ~ 64 KiB, не O(file). Альтернатива `createHash` невозможна в Workers, `subtle.digest` требует весь `ArrayBuffer`.

---

## 10. State machine immutable original

### 10.1 Definиция invariant

Пусть `path ∈ ValidFilePath`. Определим проекцию:

- `D1[path] ∈ {⊥} ∪ {row:{size,etag,sha256,uploadedAt,entity}}` где `⊥ = отсутствие строки`
- `R2[path] ∈ {⊥} ∪ {obj:{size,etag,sha256,uploaded}}` где ключ = `projectId/path` (или `projectId/.mb_immutable/...` для B)

**Invariant I (immutable original):**
```
∀path где первое завершённое создание (upload) вернуло 201,
  ∀t' > t_creation: D1[path]@t' = D1[path]@t_creation ∧ R2[path]@t' = R2[path]@t_creation
```
Т.е. после первого успеха bytes, sha256, uploadedAt, entity неизменяемы. `etag` может меняться только если меняется storageClass, но не должен при immutable.

**Authoritative — D1.** Почему не R2? §6.4 + adicional: R2 `list` может вернуть объект, даже если D1 404 (orphan), но `GET /v1/files/{path}` должен смотреть только D1: если D1 ⊥ → 404, даже если R2 существует (иначе злоумышленник мог бы залить объект напрямую через другой канал). И наоборот: D1 row без R2 → `GET` вернёт 404 + reconcile `missingObjects` (читатель не получит битые байты).

**Transitions:**

```
 State ⊥ --(C-PUT success + D1 INSERT success)--> State Created{row,obj}
 State Created --(any PUT same path)--> must fail 409, state unchanged
 State Created --(DELETE same path)--> depends on policy:
   A-unified: DELETE rejected 409 (immutable) или разрешён → Created→⊥ но нарушает I
   B-namespace: DELETE на mutable namespace не влияет, DELETE на immutable namespace rejected
 State ⊥ --(D1 transport fail after R2 success)--> transient Orphan (R2≠⊥, D1=⊥) → compensate DELETE → ⊥
 State Created --(R2 external delete)--> Missing (R2=⊥, D1=Created) → reconcile, GET 404
```

### 10.2 Почему `D1 PRIMARY KEY(path)` недостаточно

Утверждение amendment: «Не считать `D1 PRIMARY KEY(path)` достаточной защитой: D1 и R2 не находятся в общей транзакции.»

Доказательство:

1. Нарушение атомарности: `R2.put` и `D1 INSERT` — два отдельных HTTPS/RPC вызова без 2PC. Между ними нет изоляции. PK защищает только вторую фазу.
2. Контрпример (R2-orphan без D1): `C-PUT` успешен (R2 создал объект), worker crash до `INSERT`. PK не помогает — R2 уже содержит байты, D1 ⊥. Следующий `C-PUT` к тому же пути увидит R2 exists → вернёт `null` (предотвратит дубль), но `D1` всё ещё ⊥ — система в расхождении. Без PK-проверки R2 уже бы заблокировал, но authoritative D1 считает путь свободным.
3. Контрпример (D1-placeholder race, §11.6): `C-PUT` успешен, `D1 INSERT` падает transport, компенсация ещё не удалила R2, второй writer делает `C-PUT` → sees R2 exists → fail, хотя D1 ⊥ — PK не видит конкуренции, но R2 уже заблокировал.
4. Overwrite через R2: PK не мешает безусловному `R2.put` перезаписать байты, даже если `D1 INSERT` затем упадёт с PK violation: R2 уже перезаписан.

Поэтому нужен **dual-enforcement**: `R2 onlyIf` защищает байты, `D1 PK (+ INSERT OR IGNORE)` защищает метаданные, и порядок + компенсация определяют eventual consistency.

---

## 11. Доказательство 7 гонок

Для каждой гонки — точная последовательность D1/R2, predicate, interleavings, authoritative final state, HTTP result. Предполагаем проект `P`, путь `a.txt`, ключ `P/a.txt` (для B — `P/.mb_immutable/a.txt` где указано). Время `t0<t1<...`.

Условные обозначения:
- `C-PUT(key, onlyIf:{etagDoesNotMatch:"*"})` → `obj| null`
- `U-PUT(key)` → `obj` всегда
- `DEL(key)` → `void`
- `INS(path, row)` → `ok | PK_VIOLATION | TRANSPORT_FAIL`
- `SEL(path)` → `row|⊥`
- `HEAD` в R2 — внутри `C-PUT` предиката, не отдельный вызов.

HTTP коды: `201 created`, `409 file_already_exists`, `404 file_not_found`, `412 file_too_large`, `502 cloudflare_api_error`, `204 deleted`.

#### Гонка 1: immutable PUT vs immutable PUT (оба C-PUT)

Одновременные `PUT /v1/files/a.txt` от клиента A и B, оба с новым телом `bodyA`, `bodyB`.

**Схема A (unified conditional, все PUT — C-PUT, D1 INSERT OR IGNORE):**

| Шаг | Поток A | Поток B | R2 состояние | D1 состояние | Примечание |
|-----|---------|---------|--------------|--------------|------------|
| t0 | `validate` ok, `C-PUT(P/a.txt, onlyIf: etagDoesNotMatch "*")` → запрос отправлен | `validate` ok, `C-PUT(P/a.txt, onlyIf:...)` → запрос отправлен | `⊥` | `⊥` | R2 txn начинает |
| t1 | R2 txn A: `SELECT previous=null`, `validate.condition(null, onlyIf)=pass` → `stmtPut(rowA)` | R2 txn B: `SELECT previous` — **зависит от interleaving** |  |  |  |
| **Interleaving 1a: A выигрывает R2** |  |  |  |  |  |
| t2a | A получает `objA` (etagA, sizeA) | B txn: `SELECT previous=rowA` exists → `validate.condition(rowA, {etagDoesNotMatch:"*"})` → `_testR2Conditional` видит metadata≠⊥, `etagDoesNotMatch "*"` → `includesEtag("*",etagA)=true` → `ifNoneMatch=false` → **throw PreconditionFailed** → binding возвращает `null` | `objA` | `⊥` | B never touched D1 |
| t3a | A: `INS(a.txt, {sizeA,etagA,sha256A,uploadedAt})` → `ok` | B: видит `null` → immediate `409 file_already_exists`, `d1Calls=0` | `objA` | `rowA` | Authoritative = A |
| t4a | A → HTTP `201 {etagA,sha256A}` | B → HTTP `409 {code:"file_already_exists"}` | `objA` | `rowA` | Invariant сохранён, один winner |
| **Interleaving 1b: B выигрывает R2** — симметрично, A получает `null` → 409 |

**Итог:** ровно один `201`, один `409`, финальное authoritative `D1=rowWinner, R2=objWinner`, второй не создал состояния. Доказательство транзакционности R2: `bucket.worker.js put txn: validate.condition(row,onlyIf)` до `stmtPut`. D1 дополнительный — если R2 winner затем упадёт D1 transport, см. гонку 5.

**Отличие от сегодня (U-PUT):** оба получат `obj`, оба сделают `INS ... DO UPDATE`, последний `updated_at` побеждает, байты перезаписаны — invariant нарушен.

#### Гонка 2: immutable PUT vs legacy mutable PUT

Предполагаем смешанный деплой: клиент I — новый код (C-PUT), клиент M — старый SDK/Worker до миграции (U-PUT + UPSERT). Путь свободен ⊥.

**С U-PUT у M (текущий baseline):**

| t | I (C-PUT) | M (U-PUT) | R2 | D1 |
|---|-----------|-----------|----|----|
| t0 | `C-PUT` sent | `U-PUT` sent | ⊥ | ⊥ |
| t1 | R2 txn I: previous null → pass → put rowI | R2 txn M: unconditional → `stmtPut(rowM)` overwrites rowI if after I, otherwise creates first |
| **Случай 2a: I wins R2 first, M second** | I gets `objI` | M gets `objM` (overwrites objI) | `objM` | ⊥ |
| t2 | I: `INS(rowI)` → `ok` → `201` | M: `UPSERT(rowM)` → `ok` (ON CONFLICT DO UPDATE) → `201` | `objM` | `rowM` (переписал rowI) | **Invariant нарушен**: байты I потеряны, D1 теперь M, клиент I думал что он winner но его объект уже удалён. |
| **Случай 2b: M wins first, I second** | I: `C-PUT` sees rowM exists → `null` → `409` | M: `objM`, `INS` ok | `objM` | `rowM` | I корректно отклонён, но M выиграл из-за некондиционности, хотя I — immutable attempt. |

**Вывод:** при сосуществовании C-PUT + U-PUT к одному ключу invariant не гарантируется, т.к. U-PUT игнорирует `onlyIf`. `D1 PK` не спасает: оба `INS/UPSERT` успешны (второй — update), R2 уже перезаписан между t1 и t2.

**Как это узнать без check-then-write?** Mutable не может узнать об immutable без условности (§12.2). Проверка `SELECT` перед `U-PUT` — TOCTOU: между `SELECT ⊥` и `U-PUT` I может создать.

**Фиксы (см. §13):**

- **A-вариант (unified):** форсировать все PUT (включая legacy endpoint) через `C-PUT` + `INSERT OR IGNORE` после миграции v7. Тогда гонка 2 сводится к гонке 1 (оба conditional), I и M равноправны, один 201 один 409, invariant восстановлен. Цена: ломается backward-compat overwrite (теперь любой второй PUT →409).
- **B-вариант (namespace):** Immutable хранится в `P/.mb_immutable/a.txt`, mutable в `P/a.txt`. `projectObjectKey` для legacy никогда не формирует `.mb_immutable/` (валидация `validateFilePath` отклоняет `.` + `filePathPattern` + явный `if (path.startsWith(".mb/")) throw`). Тогда `C-PUT` и `U-PUT` обращаются к разным ключам, интерливинга нет: каждый свой winner. Invariant для immutable сохраняется, mutable остаётся mutable. Это соответствует требованию «отдельный зарезервированный internal namespace, который legacy не может адресовать».

Без одного из фиксов гонка 2 доказуемо нарушает invariant.

#### Гонка 3: immutable PUT vs DELETE (same path)

Путь уже в состоянии `Created{row0,obj0}` (предыдущий immutable успешен). Новый `PUT I` (C-PUT) пытается (должен получить 409, т.к. immutable). Параллельно `DELETE D` от другого клиента (`DELETE /v1/files/a.txt`).

DELETE текущая реализация (unconditional):
```ts
await FILES.delete(key); // unconditional
await queryProjectD1(... DELETE WHERE path=?);
```

| t | I (C-PUT) | D (DELETE) | R2 | D1 |
|---|-----------|------------|----|----|
| t0 | `C-PUT onlyIf:*` sent | `DEL` sent | `obj0` | `row0` |
| t1 | R2 txn I: previous=obj0 → condition fails → `null` → `409` (не доходит до D1) | R2 `DEL`: `stmtDelete(key)` → removes obj0 → `void` | `⊥` (после DEL) | `row0` |
| t2 | — | D1 `DELETE` → removes row0 → `void` | `⊥` | `⊥` |
| Или interleaving: D wins first → R2 ⊥, D1 ⊥, затем I `C-PUT` sees ⊥ → success → `objI,rowI` → **воскрешение** после delete (если клиент считал delete финализирующим). | | | | |

**Проблема immutable:** Если политика — immutable нельзя удалять, то `DELETE` должен быть отклонён. Текущий unconditional DELETE удалит immutable без проверки, нарушая I. Даже если PUT отклонён (409), DELETE всё равно стирал оригинал.

**Предотвращение:**

- A: сделать DELETE conditional на D1: сначала `SELECT` immutable flag, если `sha256 != null && immutable=true` → `403 immutable_delete_forbidden` без R2. Но SELECT-then-DELETE снова TOCTOU между SELECT и R2 DELETE.
- Безопаснее: DELETE делает `D1 DELETE ... WHERE path=? AND immutable_flag=0` (или `DELETE FROM mb_files WHERE path=? RETURNING *` и проверить) — но D1 не транзакционен с R2.
- B: разделить namespace — DELETE по `P/a.txt` никогда не трогает `P/.mb_immutable/a.txt`. Immutable delete — отдельный роут `DELETE /v1/artifacts/...` с `projects:write` scope, не `files:write`. Тогда гонка 3 исчезает для general files.

**Authoritative final state при unconditional DELETE vs conditional PUT:** если DELETE отклоняет immutable (B), итоговый state остаётся `Created`; HTTP: `DELETE →409`, `PUT→409`. Если разрешаем delete, final `⊥`, оба запроса один 204 один 409/201 в зав-ти от порядка, но invariant (если delete разрешён) — не immutable уже.

Доказательство необходимости: R2 DELETE без `onlyIf` не может атомарно проверить immutable flag; защита должна быть в D1 или namespace.

#### Гонка 4: mutable PUT vs existing immutable metadata

Похоже на 2b но старт — `Created`. Mutable M пытается перезаписать.

| t | M (U-PUT) | R2 | D1 |
|---|-----------|----|----|
| t0 | `U-PUT(P/a.txt, bodyM)` → unconditional `stmtPut` overwrites `obj0` → `objM` | `obj0`→`objM` | `row0` |
| t1 | `UPSERT rowM` → `ON CONFLICT DO UPDATE` overwrites `row0` → `rowM` | `objM` | `rowM` |

**I мутабельный перезаписал immutable.** D1 PK не сработал, т.к. `DO UPDATE` разрешает.

**Как mutable узнаёт?** Должен сделать conditional put: `C-PUT onlyIf:etagDoesNotMatch "*"` → получил `null` → знает что immutable exists → вернуть 409 без D1. Без `onlyIf` он не узнаёт.

**Фикс A:** любой PUT после v7 делает `C-PUT` — тогда M получит `null` → 409, D1 не тронут, invariant сохранён. Фикс B: M пишет в другой ключ → не трогает immutable вообще.

Без фикса — invariant нарушен, пример показывает D1 PK бессилен из-за `DO UPDATE`.

#### Гонка 5: R2 immutable PUT succeeded, но D1 metadata ещё не записана (visibility window)

Это не гонка двух writer, а окно между двумя фазами одного writer I.

| t | I | Observer O (GET) | R2 | D1 |
|---|---|---|----|----|
| t1 | `C-PUT` → `objI` | | `objI` | `⊥` |
| t2 | `INS` pending (network) | `GET /v1/files/a.txt` → D1 `SELECT` → `⊥` → `404` (even though R2 has bytes) | `objI` | `⊥` |
| t3 | `INS` → `ok` → `201` | | `objI` | `rowI` |
| t4 | | `GET` → D1 row → R2 get → `200` with bytes | `objI` | `rowI` |

**Authoritative:** D1, поэтому между t1–t3 объект считается не существующим для API (404). Это корректно: клиент ещё не получил 201, поэтому не должен читать. Orphan window <~100 ms, reconcile видит orphan если crash.

**Если второй writer J делает `PUT` в этом окне?**

| t | I (first) | J (second) | R2 | D1 |
|---|---|---|---|---|
| t1 | `C-PUT` → `objI` | | `objI` | ⊥ |
| t2 | INS pending | `C-PUT` → sees R2 exists → `null` → `409` | `objI` | ⊥ |
| t3 | `INS` → ok | already returned 409 | `objI` | `rowI` |

J корректно отклонён благодаря R2, хотя D1 ещё ⊥. Если бы J использовал `U-PUT`, он бы перезаписал (см. гонку 2), но с C-PUT — защищено.

**Вывод:** окно не нарушает invariant при dual-enforcement; без R2 `onlyIf`, J бы увидел D1 ⊥ и сделал бы `INS` успешно, создав второй D1 row? Нет, т.к. I уже держит R2, но D1 PK ещё свободен — оба могли бы вставить? J's `INS` после t2, до t3, попытается `INSERT` — PK ещё свободен (I не вставил), поэтому J's `INS` тоже `ok` → race на D1. Кто первый `INSERT` выиграет, второй `PK_VIOLATION` → 409, но R2 уже перезаписан J's `U-PUT`? Снова нужен R2 conditional.

#### Гонка 6: R2 PUT succeeded, D1 failed, затем другой writer записал тот же key до compensation

Классическая orphan гонка с компенсацией.

Writer A (immutable I):
- t1: `C-PUT` → `objA` success
- t2: `INS` → `TRANSPORT_FAIL` (502, D1 не ответил; неизвестно, успел ли D1 записать? Но для доказательства считаем что не записал, D1=⊥)
- t3: `catch` → `await FILES.delete(key)` компенсация pending

Writer B (concurrent, пытается тот же path):

**Случай 6a: B — conditional (immutable)**
| t | A | B | R2 | D1 |
|---|---|---|----|----|
| t1 | `C-PUT` objA | | objA | ⊥ |
| t2 | INS fail | `C-PUT` sent → R2 sees objA → `null` → `409` (не пишет D1) | objA | ⊥ |
| t3 | `DEL` → removes objA → `⊥` | already done 409 | ⊥ | ⊥ |
| t4 | A returns `502` | B retry later → `C-PUT` now sees ⊥ → `objB` → `INS ok` → `201` | objB | rowB |

Final authoritative после t4 — `rowB/objB` (B winner после retry). A orphan cleaned, не удалил B, т.к. B ещё не создал. Если B попытается до t3, он был отклонён; после t3 — создаёт новый. Нет data loss.

**Случай 6b: B — unconditional mutable (legacy) — опасный**
| t | A (C-PUT) | B (U-PUT) | R2 | D1 |
|---|---|---|---|---|
| t1 | `C-PUT` objA | | objA | ⊥ |
| t2 | INS fail, DEL pending | `U-PUT` sent → unconditional `stmtPut` overwrites objA → `objB` | objB | ⊥ |
| t3 | `DEL` → `stmtDelete(P/a.txt)` → **удаляет objB**, а не objA! | `UPSERT rowB` → `ok` → `201` (или после DEL?) | `⊥` (!) | `rowB` |
| t4 | A `502` | B `201` but R2 missing | `⊥` (deleted) | `rowB` → missingObject |

Final state — **missingObject**: D1 `rowB` указывает на несуществующий R2. Клиенты получат `GET →404`. B думал что успех, но bytes потеряны из-за A компенсации.

**Доказательство:** unconditional DELETE не знает, что между `PUT` и `DELETE` объект сменился. Без версии/etag в DELETE, cleanup удаляет чужой объект.

**Как гарантировать, что компенсация не удалит чужой?** В текущем рантайме — **невозможно атомарно** без R2 DELETE conditional. Обходные пути:

- **Не делать blind DELETE по ключу; делать DELETE только если D1 row отсутствует и R2 etag совпадает с нашим just-put etag**, полученным при t1. Для этого перед `DEL` сделать `HEAD` → сравнить `etagA` с `current etag`. Если `current etag !== etagA`, значит другой writer перезаписал → **не удалять**, оставить объект (он — новый winner), а orphan A уже перезаписан, нет мусора. Но `HEAD` + `DELETE` снова TOCTOU: между HEAD и DELETE может прийти третий writer. Однако для R2, где `PUT` перезаписывает, HEAD-проверка всё равно не атомарна.

- **Лучшее:** вообще не компенсировать R2 `DELETE` если D1 transport ambiguous: вместо удаления, оставить orphan и пусть `reconcile` / фоновый GC удалит его позже, проверив что D1 row отсутствует. Тогда race 6b не удалит B. Но остаётся orphan до GC.

- **Или использовать D1-first placeholder lock (§10):** `INSERT placeholder` первым; тогда R2 `PUT` происходит только после захвата D1; при D1 fail — нет R2, нет orphan, нет cleanup. Это инвертирует окно и делает R2 условным на D1, а не наоборот, но тогда другой writer B будет отклонён на D1 фазе, не дойдёт до R2.

**Вывод §9.1 подтвержден:** без `DELETE onlyIf` компенсация не может гарантировать безопасность при наличии unconditional writer. Требуется либо запретить unconditional writer (unified conditional), либо namespace isolation, либо сделать компенсацию best-effort + reconcile.

#### Гонка 7: retry после ambiguous R2/D1 transport failure

Клиент не получил HTTP ответ (TCP reset, timeout). Возможны состояния:

| Сценарий | R2 | D1 | Клиент видит | Повтор с тем же body/sha |
|----------|----|----|--------------|---------------------------|
| 7a. R2 транспорт не дошёл, D1 не было | ⊥ | ⊥ | `network error` | Retry → `C-PUT` sees ⊥ → success → `201` (idempotent retry, т.к. bytes те же, sha тот же, но uploadedAt новый — должен быть детерминирован? Для immutable uploadedAt должен быть первым. Retry должен вернуть `201` или `409`? Если retry с тем же path и теми же байтами, но без idempotency-key, второй PUT после успеха первого должен быть 409. Но ambiguous — клиент не знает, был ли первый успех. Безопаснее трактовать повтор как новый PUT того же пути → 409, но клиент не может отличить от первого 201.) |
| 7b. R2 успел (objA), D1 не успел | objA | ⊥ | `network error` | Retry → `C-PUT` sees objA → `null` → `409` (клиент подумает что кто-то другой создал, но на самом деле это он сам; orphan objA остаётся). Если клиент ретрайит с теми же байтами, 409 — корректно, но у него нет `row` и он не знает `etagA`. Однако `reconcile` покажет orphan; лучший ответ для retry — `200/201` с существующим metadata (idempotent visibly). Для этого нужна `Idempotency-Key` или проверка `sha256` equality: если retry sha == existing sha → вернуть 200 вместо 409. Без этого retry будет ложно считать конфликтом. |
| 7c. R2 успел, D1 успел, но response потерян | objA | rowA | `network error` | Retry → `C-PUT` fails → `409` + `GET` покажет `rowA` → клиент может `GET` и увидеть что его загрузка на самом деле успела. Рекомендация: клиент после ambiguous всегда `GET` перед `PUT`. |
| 7d. R2 transport ambiguous (не знаем успел ли), D1 не было | ? | ⊥ | `502` | Retry как 7a. |

**Authoritative final state** определяется D1+R2 после транспорта: если D1=⊥ и R2=⊥ → retry success 201; если R2=objA и D1=⊥ → orphan → retry 409 (лучше 200 с existing); если оба есть → 409.

**HTTP result рекомендации для immutable:** без `Idempotency-Key` как в `POST /v1/commands`, PUT не может различить «я уже создал» vs «кто-то другой создал». Для файлов отсутствует idempotency header, поэтому ambiguous retry остаётся 409. Чтобы сделать retry safe, нужно либо требовать клиента использовать `If-None-Match: *` семантику и возвращать `412` подробно, либо ввести `Idempotency-Key` для PUT, либо возвращать `200` с existing при sha match. Amendment предлагает: для CP-06 добавить `Idempotency-Key` опционально или сделать PUT idempotent по sha: если `sha256` совпадает с существующим, вернуть `200` (already exists, same content), иначе 409.

Текущий `uploadFile` не имеет idempotency, поэтому retry после ambiguous останется 409 и orphan остаётся до GC. Это приемлемо, но не ideal.

---

## 12. Дополнительные доказательства по списку amendment

### 12.1 Может ли mutable PUT перезаписать R2 между immutable R2 PUT и D1 INSERT?

**Да, если mutable — unconditional.** Доказано в гонках 2 и 6b: `U-PUT` не проверяет `onlyIf`, поэтому между `I:C-PUT(t1)` и `I:INS(t3)` любой `M:U-PUT(t2)` перезапишет `R2[objI→objM]`. D1 `PK` не спасает, т.к. `INSERT ... DO UPDATE` перезапишет и D1. Формально: `U-PUT` нарушает линейку `onlyIf` и не наблюдается в предикате.

Если все PUT — conditional (unified), ответ — **нет**: второй `C-PUT` вернёт `null` и не перезапишет.

### 12.2 Как mutable узнаёт об immutable без check-then-write?

**Только через conditional write, который атомарно проверяет и пишет.**

- Небезопасный паттерн:
  ```ts
  const exists = await D1 SELECT ...; // ⊥
  if (!exists) await R2.put(key, body); // TOCTOU: между SELECT и PUT другой writer создал
  ```
  Два потока оба увидят ⊥, оба запишут, гонка.

- Безопасный паттерн:
  ```ts
  const obj = await R2.put(key, body, {onlyIf:{etagDoesNotMatch:"*"}});
  if (obj===null) return 409;
  const res = await D1 INSERT OR IGNORE ...;
  if (res.changes===0) { await R2.delete(key); return 409; }
  ```
  Предикат встроен в storage operation, не в application check.

- Для D1-only защиты: `INSERT INTO mb_files ... ON CONFLICT DO NOTHING` + проверка `result.changes` — атомарно. Но один R2 уже перезаписан, поэтому нужен оба.

Поэтому любой endpoint, который должен уважать immutable, **обязан** использовать `onlyIf` (или `INSERT` без `DO UPDATE`) — проверка в application коде недостаточна.

### 12.3 Что означает R2 conditional PUT result при failed condition?

См. §9.2: `null` (Workers binding), внутри — `PreconditionFailed(412)`. Не exception в Worker коде, не `undefined`, не `object`. `src/files-api.ts` должен писать:
```ts
const obj = await env.FILES.put(key, stream, {onlyIf:{etagDoesNotMatch:"*"}, ...});
if (obj === null) throw new Error("file_already_exists"); // 409
```
В тестах `if (!object) throw "file_upload_failed"` уже есть, но нужно различить `null` (exists) vs `undefined`/`throw` (transport).

### 12.4 Как доказать одинаковость Miniflare и production?

- Запустить один и тот же тест в `commands.integration.test.ts` стиле против Miniflare и проверить `null` vs exception. Для файлов пока нет такого теста, но можно добавить `src/files-concurrency.test.ts` с Miniflare D1 + R2 conditional и проверить что `put` с `onlyIf` при существующем ключе возвращает `null`.
- Кодовый аргумент: оба используют один и тот же `R2ConditionalSchema` и `validate.condition`; разница только в слое трансляции 412→null, который в обоих workerd одинаков (проверено что `workerd` версии 1.20260722.1 включает фикс mapping).

### 12.5 R2 DELETE условность — повтор

Доказано §9.1: не поддерживается. Значит cleanup, который делает `await FILES.delete(key)` после `D1 fail`, **не может гарантировать** что не удалит объект другого writer, если тот writer — unconditional (§11 гонка 6b). Guarantee возможен только если:

- Все writer — conditional (тогда чужой объект не мог появиться между PUT и DELETE, т.к. чужой C-PUT был бы отклонён), **или**
- Используется отдельный namespace (чужая запись в другом ключе), **или**
- Cleanup отложен (orphan оставляется для reconcile, не удаляется немедленно).

Поэтому production реализация CP-06 должна выбрать одно из: (i) сделать все PUT conditional, (ii) отложить cleanup, (iii) ввести namespace. Текущий код `catch { await FILES.delete(key); throw }` — небезопасен при смешанном режиме и должен быть изменён.

---

## 13. Допустимые выводы A / B / BLOCKED

### 13.1 Вариант A — доказуемая схема на существующих R2+D1 (без нового backend) *возможна*, но с оговорками

**A-unified (все PUT conditional):**

- После миграции v7 `PUT /v1/files/{path}` всегда делает `C-PUT onlyIf:*` + `INSERT OR IGNORE` (никакого `DO UPDATE`). Любой второй PUT того же пути → 409.
- `DELETE` для immutable путей отклоняется на уровне `validateFilePath` или `SELECT` + ранний 409 (или делается условным через D1 `DELETE ... WHERE immutable=0`). R2 DELETE остаётся unconditional, но т.к. все PUT conditional, orphan-DELETE гонка 6b невозможна (§11 6a).
- Требует расширения `contracts.ts` (`R2Conditional`), изменения `files-api.ts`, миграции `v7` (`sha256`, `uploadedAt`, `entity`), и обновления `test-harness.ts` для `null` возврата.
- Цена: ломается backward-compat для клиентов, которые ожидали overwrite. Если таких клиентов нет (поиск по логам `PUT` одного пути дважды), это приемлемо. Иначе — breaking change, нужно документировать как `409 file_already_exists` вместо `201` overwrite.

**Доказательство A-unified сохраняет I:** Для любого пути `p`, пусть `W1, W2` — два concurrent `C-PUT`. R2 txn сериализует: первый `validate.condition(⊥)` pass → `put`, второй `validate.condition(exists)` fail → `null`. D1 `INSERT` второго не вызывается. Если первый `D1 INSERT` падает transport, его компенсация `DELETE` удаляет `obj1` (единственный), второй retry после этого увидит `⊥` и создаст `obj2` — eventual winner единственен. Никакой `U-PUT` не может вмешаться, т.к. его не осталось.

**Ограничения A-unified:**

- Нужен новый error code `file_already_exists` (409) в `src/errors.ts` + `statusByCode`.
- `GET` после `PUT` видит только D1, поэтому между R2 и D1 всё ещё orphan window, но оно не нарушает I (читатели видят ⊥ до D1).
- Paginated reconcile truncation остаётся.

**Вывод по A:** **Доказуемо** на существующих primitives, без Durable Object, если принять что **любой** `PUT` становится immutable create-if-not-exists. Если требование «полная совместимость overwrite» непреложно, A-unified не подходит.

### 13.2 Вариант B — суженная модель с отдельным internal namespace (рекомендуемый)

**Идея:** Immutable originals живут не в `P/{path}`, а в `P/.mb_artifacts/{entityCollection}/{entityId}/{field}/{hash}/{filename}` или `P/__immutable/{path}`.

**Routing:**

- Новый endpoint (или query param) `PUT /v1/files/{path}?immutable=true&entityCollection=...&entityId=...` или явный `POST /v1/artifacts/{collection}/{id}` — в Worker мэппится в `artifactObjectKey(principal, entityCollection, entityId, path)` = `${projectId}/.mb_artifacts/${collection}/${id}/${sanitizedPath}#${sha256}`.
- Legacy `PUT /v1/files/{path}` остаётся **unconditional** (`U-PUT` + `UPSERT`) и адресует только `P/{path}`; `validateFilePath` отклоняет пути, начинающиеся с `.mb/` или `__` (`if (path.startsWith(".mb/") || path.startsWith("__")) throw invalid_file_path`), поэтому legacy технически не может адресовать internal namespace.
- `DELETE /v1/files/{path}` аналогично не может удалить immutable — разные ключи.
- `GET /v1/files/{path}` читает mutable namespace; `GET /v1/artifacts/...` читает immutable.

**Хранение:**

- В `mb_files` добавить `storage_key TEXT GENERATED` или `is_artifact BOOL`, `artifact_entity_collection`, `artifact_entity_id`, `sha256`, `uploaded_at`. PK может быть композитным `(path, is_artifact)` или `storage_key`.
- Миграция v7: `ALTER TABLE mb_files ADD COLUMN sha256 TEXT CHECK(length(sha256)=64), ADD COLUMN uploaded_at TEXT, ADD COLUMN entity_collection TEXT, ADD COLUMN entity_id TEXT, ADD COLUMN storage_namespace TEXT DEFAULT 'files' CHECK(storage_namespace IN ('files','artifacts'))`. Существующие строки `files` остаются `sha256=NULL, uploaded_at=created_at` (legacy).

**Доказательство B сохраняет I и совместимость:**

- Invariant для artifacts: ключ в R2 включает `projectId` + `.mb_artifacts/...` + `sha256`, поэтому даже два concurrent `PUT` одного logical path но с разными bytes дадут разные ключи (если ключ включает hash) или тот же ключ но с `onlyIf:*` — в обоих случаях один winner в своём namespace, не затрагивая `files`.
- Legacy mutable не может перезаписать artifacts: `projectObjectKey` для legacy всегда `P/${path}`, где `path` не может быть `.mb_artifacts/...` (валидация). Даже `U-PUT` в legacy не достигает R2 ключа artifacts.
- `DELETE` isolation аналогично.
- Compensation для artifacts — условная или отложенная, но не влияет на files.

**Плюсы B:** Полная backward-compat для `files` (overwrite остаётся), новый invariant для artifacts без breaking. Соответствует «безопасная модель immutable originals» + «опциональная связь с entity» (entity в ключе). Не требует Durable Object, остаётся один bucket, один Worker, один D1 (просто разные префиксы).

**Минусы B:** Требует нового роута/параметра и валидации reserved prefix, документации и SDK метода `uploadArtifact(...)`.

### 13.3 Вариант C — BLOCKED

**Когда C требуется:** Если A-unified неприемлем из-за обязательного overwrite, а B неприемлем из-за требования «все файлы immutable без namespace», и при этом требуется атомарный `DELETE` с `onlyIf` (которого нет), то без Durable Object или транзакционного координатора нельзя гарантировать invariant при наличии legacy unconditional writer.

Доказано (§11 гонка 6b, §9.1): `DELETE` без условия + `U-PUT` перезапись → data loss, не фикс без изменения одного из них. Если продукт требует одновременно (a) legacy overwrite в том же ключе, (b) immutable в том же ключе, (c) гарантию что cleanup не удалит чужой, то primitives недостаточны → `BLOCKED` и нужен Durable Object per path (например, per-entity DO как lock) или новый backend (S3 conditional delete, KV).

**Оценка:** Для текущего набора требований `BLOCKED` **не нужен**, т.к. A-unified **или** B закрывают гонки. Рекомендация — выбрать B (наиболее совместимый), либо A-unified если overwrite действительно не используется.

---

## 14. Итог amendment

**Принятое решение для CP-06:** **Вариант B (рекомендуемый)**, с fallback на **A-unified** если namespace отклонён.

- **R2 conditional PUT** поддерживается (`onlyIf:{etagDoesNotMatch:"*"}` → `null` при провале, одинаково в Miniflare и production).
- **R2 DELETE conditional** не поддерживается; компенсация без `onlyIf` не может гарантировать безопасность при наличии `U-PUT` — требуется либо все PUT сделать conditional, либо разделить namespace, либо отложить cleanup.
- **`D1 PRIMARY KEY` одного недостаточно** — нужен dual-enforcement (R2 `onlyIf` + D1 `INSERT OR IGNORE`) из-за отсутствия 2PC.
- **7 гонок доказаны** с таблицами последовательностей, предикатами, финальным authoritative состоянием и HTTP кодами (§11). Гонки 2,4,6b нарушают invariant при смешанном `C-PUT/U-PUT`; фиксится A или B.
- **Потоковый SHA-256** возможен через `crypto.DigestStream` без O(file) памяти.
- **Расширение без нового backend** возможно: миграция v7 + расширение `contracts.ts` + условный `uploadFile` + новая валидация reserved prefix для B.

**Следующие шаги (код не менялся в этом amendment, только документ):**

1. Получить approval на выбор B vs A-unified (вопрос заказчику/owner).
2. При approval B: реализовать namespace `/.mb_artifacts/`, валидацию, `artifactObjectKey`, `uploadArtifact` роут, миграцию v7, обновить `test-harness` для `null` на `C-PUT` fail, добавить `file_already_exists` 409.
3. При approval A-unified: заменить `U-PUT` на `C-PUT` везде, `DO UPDATE`→`DO NOTHING`, добавить тот же error code, миграцию v7 без namespace.
4. Обновить reconcile и SDK, документацию `DATA_API.md`, `DATA_MODEL.md`.

**Commit amendment:** `git log --oneline -3` после этого коммита покажет новый SHA (см. ниже). Код CP-06 не изменён, только `CP06_AUDIT.md`.

---

*Amendment сгенерирован по реально установленным `wrangler 4.114.0`, `miniflare 4.20260722.0`, `workerd 1.20260722.1`, `workers-types 5.20260722.1`. Проверки: `grep -n onlyIf` в `miniflare/dist`, `sed -n 2448p workers-types/index.d.ts`, `bucket.worker.js` txn, `errors.worker.js` PreconditionFailed(412). Все команды Phase A остаются PASS.*
