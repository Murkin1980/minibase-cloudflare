# MiniBase — финальный чек-лист приёмки

Дата фиксации: 2026-07-29
Статус инфраструктуры: **ГОТОВО / ACCEPTED**
Версия подтверждённого production smoke: `0.22.1`

## 1. Локальные проверки кода

Перед любым следующим релизом выполнить из корня репозитория:

```bash
npm install
npm run check
```

Команда `npm run check` обязана включать и завершать без ошибок:

- [x] ESLint;
- [x] TypeScript typecheck;
- [x] unit-тесты;
- [x] D1-тесты;
- [x] release-readiness тесты;
- [x] Worker-тесты;
- [x] production build.

Критерий: код возврата `0`, без пропущенных обязательных проверок.

## 2. Production-инфраструктура

- [x] Cloudflare Worker развёрнут;
- [x] управляющая D1 создана;
- [x] все 6 control migrations применены;
- [x] R2 Standard bucket `minibase-files` подключён;
- [x] rate limiter настроен;
- [x] `CLOUDFLARE_D1_API_TOKEN` хранится как Worker secret;
- [x] Cloudflare API token не хранится в Git;
- [x] management key хранится только в доверенном хранилище;
- [x] в D1 хранится только SHA-256 management key;
- [x] утраченный первоначальный management key отозван.

## 3. Production smoke

- [x] `/health` возвращает успешный контракт MiniBase;
- [x] присутствует `x-minibase-request-id`;
- [x] безопасные response headers проверены;
- [x] запрос management API без ключа отклоняется;
- [x] авторизованный `GET /v1/audit-events` проходит;
- [x] smoke-скрипт не печатает management key;
- [x] последний подтверждённый smoke: 2026-07-29, версия `0.22.1`.

Безопасный повтор production smoke в PowerShell:

```powershell
$env:MINIBASE_MANAGEMENT_KEY = Read-Host "Management key"
npm.cmd run smoke:production
Remove-Item Env:MINIBASE_MANAGEMENT_KEY
```

## 4. Функциональная готовность платформы

- [x] provisioning отдельной D1 на проект;
- [x] идемпотентное создание проектов;
- [x] management keys со scope, отзывом и аудитом;
- [x] publishable и secret data keys;
- [x] Records Data API;
- [x] R2 files API;
- [x] allowlist browser origins;
- [x] typed client SDK;
- [x] единый безопасный формат ошибок;
- [x] rollback evidence для операций provisioning/migration;
- [x] базовое hardening и abuse control.

## 5. Что не является незавершённостью MiniBase

Следующие действия относятся не к разработке платформы, а к подключению конкретного приложения:

- [ ] создать первый проект `1c-tutor-kz`;
- [ ] выдать его publishable/secret keys;
- [ ] задать разрешённые origins;
- [ ] проверить изоляцию project D1 и файлов;
- [ ] подключить клиентское приложение.

Это отдельная onboarding-итерация. Она не меняет статус MiniBase как завершённой инфраструктурной платформы.

## 6. Правило повторного открытия разработки MiniBase

Не добавлять новые функции в MiniBase во время подключения 1C Tutor, если нет воспроизводимого дефекта платформы. Любое изменение ядра должно иметь:

1. отдельное описание проблемы;
2. тест, воспроизводящий проблему;
3. минимальное исправление;
4. полный `npm run check`;
5. production smoke, если затронут Worker-контракт;
6. запись в `SESSION_NOTES.md`.

## Итог

MiniBase Cloudflare принят как готовая внутренняя BaaS-инфраструктура. Следующая работа — onboarding первого потребителя, **1C Tutor KZ**, без возврата к Supabase.