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

Команда сначала собирает веб-интерфейс, затем запускает сервер. Откройте [http://127.0.0.1:7717/app/](http://127.0.0.1:7717/app/).

Проверка сервера:

```powershell
Invoke-RestMethod http://127.0.0.1:7717/api/health
```

Ожидаемый ответ на этапе 0:

```json
{"status":"ok","database":"ok","schemaVersion":1}
```

База по умолчанию создаётся в `data/tabhub.sqlite` относительно корня репозитория. Путь можно изменить через `TABHUB_DB_PATH` в корневом `.env`.

Для разработки UI с hot reload запустите сервер и Vite одной командой, затем откройте адрес Vite из консоли:

```powershell
corepack pnpm dev:web
```

## Расширение Chromium

Соберите один Manifest V3-билд:

```powershell
corepack pnpm --filter @tabhub/extension build
```

В каждом браузере откройте страницу расширений, включите режим разработчика и загрузите распакованную папку `packages/extension/.output/chrome-mv3`:

- Chrome: `chrome://extensions`
- Edge: `edge://extensions`
- Yandex Browser: `browser://extensions`

Откройте настройки TabHub и отдельно выберите имя текущего браузера. Это обязательно: Chromium API не позволяет надёжно отличить Chrome от Yandex Browser. В popup доступны проверка локального сервера и ручной снимок. Полный снимок также отправляется при старте, после изменений вкладок с debounce и каждые пять минут через `chrome.alarms`. Если сервер выключен, ожидающие снимки хранятся FIFO-очередью в `chrome.storage.local` и досылаются по порядку при следующей попытке.

После снимков из нескольких браузеров записи появятся в общей таблице с колонкой браузера. Повторный снимок обновляет существующую нормализованную ссылку; исчезнувшая вкладка остаётся в БД с `isOpen=false`.

### REST-проверка без расширения

```powershell
$body = @{
  browser = 'chrome'
  tabs = @(@{
    url = 'https://example.com/?utm_source=test#section'
    title = 'Example'
    windowId = 1
    index = 0
  })
} | ConvertTo-Json -Depth 4

Invoke-RestMethod -Method Post -Uri http://127.0.0.1:7717/api/ingest/snapshot -ContentType application/json -Body $body
Invoke-RestMethod http://127.0.0.1:7717/api/tabs
```

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

Файл появится в корневой папке `backups/`.

## Статус реализации

- Этап 0: каркас монорепозитория, общие схемы, миграция SQLite и healthcheck — готово.
- Этап 1: снимки из Chromium-браузеров, надёжная очередь расширения, REST ingest, дедупликация и общая таблица — готово.
- Этапы 2–7: см. [план реализации](./tab-manager-plan.md).

Инструкции по установке расширения и подключению MCP будут добавлены в соответствующих этапах.
