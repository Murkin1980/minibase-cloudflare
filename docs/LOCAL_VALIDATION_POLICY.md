# Политика локальных проверок без GitHub Actions

## Статус ограничения

GitHub Actions временно не используется, потому что лимит владельца репозитория исчерпан.
Это осознанное операционное ограничение, а не дефект MiniBase или 1C Tutor KZ.

## Обязательное правило для Coder

До каждого коммита и после любых значимых изменений Coder обязан запускать полный набор проверок локально. Нельзя считать зелёный CI обязательным критерием, пока владелец явно не восстановит GitHub Actions.

### MiniBase Cloudflare

```bash
npm install
npm run check
```

При изменениях production-конфигурации или перед подключением приложения дополнительно выполнить безопасный smoke-тест:

```powershell
$env:MINIBASE_MANAGEMENT_KEY = Read-Host "Management key"
npm.cmd run smoke:production
Remove-Item Env:MINIBASE_MANAGEMENT_KEY
```

### 1C Tutor KZ

```bash
npm install
npm run lint
npm run typecheck
npm run test
npm run build
npm run check:secrets
npm run test:e2e
```

## Требования к отчёту Coder

Coder обязан записать в итоговом отчёте и `SESSION_NOTES.md`:

- точные выполненные команды;
- результат каждой команды: PASS или FAIL;
- количество unit- и e2e-тестов;
- проверенные desktop и mobile viewport;
- дату локальной проверки;
- известные ограничения;
- явную пометку: `GitHub Actions не запускался: лимит владельца исчерпан`.

## Запреты

- Не создавать и не включать workflow только ради формального CI.
- Не тратить лимит GitHub Actions без отдельного разрешения владельца.
- Не объявлять итерацию завершённой без фактического локального запуска тестов.
- Не заменять тесты записью в документации или результатами старого коммита.
- Не коммитить management keys, Cloudflare tokens и другие секреты.

## Возврат GitHub Actions

GitHub Actions можно вернуть только после явного решения владельца. До этого момента локальный полный прогон является официальным quality gate для обоих проектов.
