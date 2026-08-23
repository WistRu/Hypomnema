# Персональный слой внимания: рецепт Rollback

- Статус: accepted
- Дата фиксации: 2026-08-23
- Решение: [decisions.md](decisions.md) 2026-08-23
- Глоссарий: [CONTEXT.md](../CONTEXT.md)
- Runbook: [personal-attention-layer-goal-runbook.md](personal-attention-layer-goal-runbook.md) §10.1

Этот файл существует, чтобы решение об откате во время Trial week принималось по
написанному правилу, а не импровизировалось.

Правило рунбука требует, чтобы рецепт **и** хешированный артефакт отката были
зафиксированы до Rollout. Рецепт был: он написан 2026-08-23 до миграции живой
базы. Артефакт — нет: `rollback/trial-week-feature-off.env`, его smoke и хеш
появились уже после Rollout (issue #18, receipt
`C98-rollback-artifact-receipt.json`). Читать это как соблюдение правила на
момент Rollout нельзя.

## 1. Что такое Rollback

**Rollback — это выключение новых feature-флагов на той же схеме базы 26.**

Схема базы не понижается. Пользовательские записи не откатываются. После
Rollback база остаётся на схеме 26 со всеми данными, которые пользователь успел
накопить; Library продолжает читаться, потому что feature-off совместимость
доказана на мигрированной копии до Rollout.

Восстановление из backup — **не Rollback**. См. §5.

## 2. Какие флаги выключает Rollback

Trial week включает ровно восемь флагов. Rollback выставляет каждый из них в
`false` в `.env`:

```dotenv
TABHUB_FEATURE_CONTEXT=false
TABHUB_FEATURE_RESOURCES=false
TABHUB_FEATURE_ACTIVITY_WINDOWS=false
TABHUB_FEATURE_ACTIVITY_DAILY_WRITER=false
TABHUB_FEATURE_LOGICAL_IMPORTANCE=false
TABHUB_FEATURE_PRIORITY_READERS=false
TABHUB_FEATURE_PRIORITY_SHADOW=false
TABHUB_FEATURE_PRIORITY_PERSONALIZATION=false
```

Остальные пять флагов на всю Trial week и так выключены по deployment waiver и
при Rollback не трогаются — они уже `false`:

```dotenv
TABHUB_FEATURE_RESEARCH=false
TABHUB_FEATURE_LIVE_ACQUISITION=false
TABHUB_FEATURE_PRIVACY_PURGE=false
TABHUB_FEATURE_PAGE_SUMMARY_CAPTURE=false
TABHUB_FEATURE_PRIORITY_ASSESSMENT_WRITER=false
```

Этот набор зафиксирован как именованный артефакт `rollback/trial-week-feature-off.env`;
его SHA-256 и smoke записаны в
`docs/implementation-evidence/personal-attention-layer/C98-rollback-artifact-receipt.json`.
Проверить артефакт заново:

```bash
node rollback/verify-rollback-profile.mjs --port 7799
```

Скрипт снимает online-backup копию боевой базы, поднимает на ней ту же сборку с этим
профилем, проверяет health/схему/чтение Library и сверяет число строк во всех таблицах
до и после. Живой файл только читается.

Полный список флагов с дефолтами — в `.env.example`. Флаги fail-closed: пустое
или отсутствующее значение читается как `false`, а любое значение кроме
`1/true/0/false` останавливает старт сервера с ошибкой.

## 3. Три триггера Rollback

Rollback выполняется, если наступило хотя бы одно из трёх событий. Других
триггеров нет; всё остальное — обычный баг, который чинится без отката.

1. **Потеря или порча данных.** Пропали страницы, ресурсы, контекст или история
   активности; `PRAGMA integrity_check` не отвечает `ok`; `PRAGMA
   foreign_key_check` возвращает непустой результат.
2. **Замедление Library.** Library перестала открываться и работать с той же
   скоростью, что до Rollout, настолько, что ей неудобно пользоваться каждый
   день.
3. **Локальный текст ушёл с машины.** Любой признак того, что local-only текст
   страницы, контекст или содержимое заметок покинули машину: неожиданный
   исходящий сетевой запрос, обращение к Provider при выключенных флагах,
   запись с текстом страницы в чужом хранилище.

## 4. Порядок выполнения Rollback

1. Остановить процесс сервера Trial week; записать его PID.
2. Выставить восемь флагов из §2 в `false` в `.env`.
3. Запустить сервер той же сборкой на том же порту `TABHUB_PORT=7717`:

```bash
corepack pnpm start
```

4. Проверить `GET /api/health`: `status=ok`, `database=ok`, `schemaVersion=26`.
5. Проверить `GET /api/features`: все проецируемые флаги `false`.
6. Открыть Library и убедиться, что список страниц читается.
7. Перезагрузить расширение и убедиться, что оно подключается.
8. Записать receipt в `docs/implementation-evidence/personal-attention-layer/`:
   какой триггер сработал, старый и новый PID, HEAD сборки, `schemaVersion`,
   вывод `/api/health` и `/api/features`, свежие логи, факт перезагрузки
   расширения.
9. Обновить чекпойнт рунбука: Trial week не состоялась, счёт семи дней
   обнуляется.

Ограничение проверки: `GET /api/features` **не** проецирует
`activityDailyWriter` — этот флаг наблюдается только по `.env` и по отсутствию
ежедневных записей активности. Остальные семь флагов Trial week наблюдаемы
через `/api/features` напрямую.

## 5. Восстановление из backup — отдельный путь

Восстановление pre-rollout backup поверх живой базы **уничтожает** всё, что
пользователь записал после снятия backup. Поэтому:

- восстановление выполняется **только по отдельному явному поручению
  пользователя**, данному именно для восстановления; согласие на Rollout,
  на Rollback или на любую работу по тикету таким поручением не является;
- **агент не имеет права инициировать восстановление сам** ни при каких
  наблюдаемых симптомах, включая триггеры §3;
- до восстановления обязателен quantified reconciliation: точная дельта строк и
  действий, записанных после backup, и план того, что из них сохраняется и
  повторяется. Без этой дельты восстановление запрещено;
- pre-rollout backup остаётся disaster-recovery артефактом и хранится, даже
  если Rollback прошёл успешно.

Дефолт при любом из трёх триггеров — Rollback по §4, а не восстановление.

## 6. Что уже доказано до Rollout

- Миграция живой базы 17 → 26 на изолированной копии: `schemaVersion=26`,
  `integrity_check=ok`, `foreign_key_check` пуст, число строк в проверенных таблицах (`tabs`, `tab_instances`, `tags`, `tab_tags`) не изменилось,
  чтение Library при выключенных флагах отвечает 200, хеш живого файла не
  изменился — `G9-live-database-17-to-26-isolated-receipt.json`.
- Изолированная миграция и feature-off rollback smoke —
  `G9-isolated-migration-rollback-receipt.json`.

Это и есть доказательство, что шаг §4 сработает: feature-off чтение на схеме 26
проверено до того, как схема 26 появилась на живой базе.
