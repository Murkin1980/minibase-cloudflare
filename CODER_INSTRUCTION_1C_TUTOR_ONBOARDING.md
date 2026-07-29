# Инструкция кодеру — подключение 1C Tutor KZ к MiniBase Cloudflare

## 1. Роль и цель

Ты — senior full-stack разработчик, продолжающий два связанных проекта:

- инфраструктура: `Murkin1980/minibase-cloudflare`;
- приложение-потребитель: `Murkin1980/1c-tutor-kz`.

MiniBase уже принята как готовая production-инфраструктура. Цель следующей итерации — создать отдельный проект `1c-tutor-kz` в MiniBase, проверить его изоляцию и заменить локальное хранение прогресса тренажёра на MiniBase без Supabase.

## 2. Обязательные исходные решения

- Supabase не использовать.
- Проект предназначен для внутреннего использования одним владельцем.
- Публичная регистрация, multi-tenant, сложные роли и SaaS-биллинг не нужны.
- Frontend 1C Tutor размещается на Cloudflare Pages.
- Данные хранятся через MiniBase Worker + project D1.
- Файлы при необходимости хранятся через MiniBase R2 API.
- Управляющие и secret keys никогда не помещать во frontend.
- Frontend получает только MiniBase URL и `mb_publishable_*`.
- Доступ к самому сайту предпочтительно закрыть Cloudflare Access.

## 3. Перед началом

Прочитать в `minibase-cloudflare`:

1. `README.md`;
2. `ROADMAP.md`;
3. `docs/PRODUCTION_STATUS.md`;
4. `docs/FINAL_ACCEPTANCE_CHECKLIST.md`;
5. документацию Records API, Files API и client SDK;
6. последние записи `SESSION_NOTES.md`.

Прочитать в `1c-tutor-kz`:

1. `FOUNDATION.md`;
2. `README.md`;
3. `ARCHITECTURE.md`;
4. `DATA_MODEL.md`;
5. `ROADMAP.md`;
6. `CODER_INSTRUCTION.md`;
7. `SESSION_NOTES.md`.

Перед изменениями написать короткий план и перечень файлов.

## 4. Границы итерации

Эта итерация должна выполнить только onboarding и серверное сохранение прогресса.

Не делать:

- AI-проверку скриншотов;
- редактор курсов;
- публичную регистрацию;
- отдельную CRM;
- новые функции ядра MiniBase без доказанного дефекта;
- глубокую интеграцию с интерфейсом 1С;
- миграцию контента уроков в D1, если локальный JSON/TypeScript-контент уже работает.

## 5. Этап A — контрольная проверка MiniBase

В локальном репозитории MiniBase выполнить:

```bash
npm install
npm run check
```

Затем безопасно выполнить production smoke:

```powershell
$env:MINIBASE_MANAGEMENT_KEY = Read-Host "Management key"
npm.cmd run smoke:production
Remove-Item Env:MINIBASE_MANAGEMENT_KEY
```

Записать фактические результаты. Не копировать raw management key в отчёт, Git, логи или чат.

Если проверки не проходят, остановить onboarding, создать воспроизводящий тест и исправить только найденный дефект.

## 6. Этап B — создать проект 1C Tutor

Через management API создать отдельный проект:

- slug: `1c-tutor-kz`;
- display name: `1C Tutor KZ`;
- отдельная project D1;
- отдельные data keys;
- files включать только если в этой итерации реально проверяется загрузка файлов.

Требования:

- использовать уникальный `Idempotency-Key`;
- сохранить возвращённые ключи только один раз в доверенном хранилище;
- не коммитить ключи;
- подтвердить audit event создания;
- повторить тот же запрос с тем же телом и `Idempotency-Key`, подтвердив идемпотентность;
- не создавать дубликат проекта.

## 7. Этап C — origins и безопасность

Добавить разрешённые origins:

- локальный адрес Vite;
- фактический Cloudflare Pages preview/production origin после его появления.

Проверить:

- разрешённый origin получает CORS-заголовки;
- посторонний origin не получает доступ;
- `mb_secret_*` не присутствует в клиентском bundle;
- management key не используется приложением;
- publishable key имеет только минимально нужные scopes.

## 8. Этап D — модель данных 1C Tutor

Для внутреннего single-owner сценария использовать простую модель коллекций.

### `tutor_progress`

ID записи: стабильный идентификатор владельца, например `owner`.

Пример полей:

```json
{
  "schemaVersion": 1,
  "updatedAt": "ISO-8601",
  "lastLessonId": "string|null",
  "courseProgress": {},
  "lessonProgress": {},
  "settings": {}
}
```

### `tutor_notes`

ID записи: `lesson_<lessonId>`.

```json
{
  "schemaVersion": 1,
  "lessonId": "string",
  "text": "string",
  "updatedAt": "ISO-8601"
}
```

При необходимости ответы можно хранить внутри `lessonProgress`, не создавая лишние коллекции.

Обязательные свойства:

- Zod-валидация перед записью и после чтения;
- `schemaVersion`;
- стабильные record IDs;
- безопасная обработка пустой базы;
- отсутствие реальных бухгалтерских данных в тестах.

## 9. Этап E — интеграция в 1C Tutor

Сохранить существующие repository interfaces и добавить MiniBase-адаптеры, например:

- `MiniBaseProgressRepository`;
- `MiniBaseNotesRepository`.

Требования:

- UI не должен знать детали HTTP MiniBase;
- текущий localStorage-адаптер оставить как development fallback;
- выбор адаптера выполнять через конфигурацию окружения;
- при первом успешном подключении предложить одноразовый перенос локального прогресса;
- перенос должен быть идемпотентным;
- не затирать более свежие серверные данные старыми локальными;
- показывать понятное состояние ошибки и возможность повторить синхронизацию;
- не блокировать чтение уроков при временной недоступности backend.

Переменные окружения frontend:

```env
VITE_MINIBASE_URL=
VITE_MINIBASE_PUBLISHABLE_KEY=
```

Никаких `mb_secret_*`, `mb_management_*` или Cloudflare tokens в `VITE_*`.

## 10. Этап F — тесты

Добавить или обновить тесты:

### MiniBase

- provisioning проекта;
- идемпотентный повтор provisioning;
- origin allowlist;
- records CRUD для проекта 1C Tutor;
- изоляция от другого тестового проекта;
- запрет secret/management key в браузерном сценарии.

### 1C Tutor

- чтение пустого прогресса;
- сохранение и повторное чтение прогресса;
- сохранение заметки;
- восстановление последнего урока;
- fallback на localStorage при недоступном MiniBase;
- одноразовая миграция localStorage → MiniBase;
- разрешение конфликта по `updatedAt`;
- отсутствие секретов в bundle;
- e2e: пройти урок, обновить страницу, увидеть сохранённый прогресс;
- e2e mobile viewport.

## 11. Этап G — публикация

Развернуть 1C Tutor на Cloudflare Pages:

- production branch согласно репозиторию;
- build command: фактическая команда проекта;
- output directory: `dist`;
- добавить только publishable frontend variables;
- настроить SPA fallback;
- подключить Cloudflare Access для внутреннего доступа;
- добавить Pages origin в MiniBase allowlist.

Проверить с компьютера и смартфона:

1. вход через Cloudflare Access;
2. открытие курса;
3. прохождение урока;
4. сохранение заметки;
5. обновление страницы;
6. продолжение на другом устройстве;
7. открытие внешней 1С в новой вкладке.

## 12. Документация

В `1c-tutor-kz` обязательно обновить:

- `README.md`;
- `ARCHITECTURE.md`;
- `DATA_MODEL.md`;
- `ROADMAP.md`;
- `.env.example`;
- `CODER_INSTRUCTION.md`;
- `SESSION_NOTES.md`.

Удалить Supabase как целевую архитектуру. Можно оставить краткую запись в истории решений: «Supabase отклонён как избыточный для внутреннего single-owner проекта; выбран MiniBase Cloudflare».

В `minibase-cloudflare` обновлять ядро и документацию только при фактическом изменении платформы либо при фиксации onboarding evidence.

## 13. Критерий готовности итерации

Итерация завершена, когда:

- `npm run check` MiniBase проходит;
- production smoke MiniBase проходит;
- проект `1c-tutor-kz` создан один раз и отображается в аудите;
- его D1 изолирована;
- origins настроены;
- 1C Tutor сохраняет прогресс и заметки через MiniBase;
- межустройственное продолжение подтверждено;
- Cloudflare Pages опубликован и закрыт Cloudflare Access;
- frontend bundle не содержит secret/management keys;
- тесты 1C Tutor зелёные;
- документация не содержит Supabase как активного решения;
- `SESSION_NOTES.md` содержит фактические команды, результаты и ограничения.

## 14. Формат итогового отчёта

```markdown
## Выполнено
- ...

## MiniBase project
- project id: безопасный идентификатор, не секрет
- D1 isolation: PASS
- origins: PASS

## Проверки MiniBase
- npm run check — PASS/FAIL
- npm run smoke:production — PASS/FAIL

## Проверки 1C Tutor
- lint — PASS/FAIL
- typecheck — PASS/FAIL
- tests — PASS/FAIL
- build — PASS/FAIL
- e2e desktop — PASS/FAIL
- e2e mobile — PASS/FAIL

## Security
- publishable key only in frontend — PASS/FAIL
- secret scan — PASS/FAIL
- Cloudflare Access — PASS/FAIL

## Изменённые файлы
- ...

## Известные ограничения
- ...

## Следующий шаг
- наполнение и методическая проверка минимум 10 уроков
```

Не объявлять итерацию завершённой по документации или предположению. Требуются фактические результаты команд и smoke/e2e-проверок.