# TabHub

Локальный менеджер вкладок из нескольких Chromium-браузеров с REST, MCP и веб-интерфейсом. Сервер слушает только `127.0.0.1`.

## Требования

- Windows 10/11
- Node.js 22+
- Corepack (`corepack enable`)

## Запуск

```powershell
corepack pnpm install
Copy-Item .env.example .env
corepack pnpm dev
```

Проверка сервера:

```powershell
Invoke-RestMethod http://127.0.0.1:7717/api/health
```

Ожидаемый ответ на этапе 0:

```json
{"status":"ok","database":"ok","schemaVersion":1}
```

База по умолчанию создаётся в `data/tabhub.sqlite`. Путь можно изменить через `TABHUB_DB_PATH`.

## Проверки

```powershell
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
```

## Резервная копия

При остановленном или работающем сервере SQLite online-backup создаётся командой:

```powershell
corepack pnpm backup
```

Файл появится в `packages/server/backups/`.

## Статус реализации

- Этап 0: каркас монорепозитория, общие схемы, миграция SQLite и healthcheck.
- Этапы 1–7: см. [план реализации](./tab-manager-plan.md).

Инструкции по установке расширения и подключению MCP будут добавлены в соответствующих этапах.
