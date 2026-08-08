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

Текущий ожидаемый ответ:

```json
{"status":"ok","database":"ok","schemaVersion":4}
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

Откройте настройки TabHub и отдельно выберите имя текущего браузера. Это обязательно: Chromium API не позволяет надёжно отличить Chrome от Yandex Browser. В popup доступны проверка локального сервера, ручной снимок и захват контента текущей либо всех доступных HTTP(S)-вкладок. Полный снимок также отправляется при старте, после изменений вкладок с debounce и каждые пять минут через `chrome.alarms`. Если сервер выключен, ожидающие данные хранятся FIFO-очередью в `chrome.storage.local` и досылаются по порядку при следующей попытке.

Контент извлекается только по команде: Readability получает основной текст и HTML статьи, а для страниц без подходящей статьи используется `document.body.innerText`. Автоматического обхода всех вкладок в v1 нет.

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

### Полнотекстовый поиск

После захвата контента поиск работает по заголовку, очищенному тексту и будущему summary:

```powershell
Invoke-RestMethod 'http://127.0.0.1:7717/api/tabs?q=local-first'
```

В веб-интерфейсе тот же параметр доступен в строке поиска над таблицей.

### Суммаризация по запросу

TabHub никогда не суммаризирует вкладки автоматически. Чтобы включить ручные запросы из UI или MCP, задайте `ANTHROPIC_API_KEY` в `.env` и перезапустите сервер. По умолчанию короткий режим использует `claude-haiku-4-5-20251001`, глубокий — `claude-sonnet-5`; модели и расчётные цены можно переопределить переменными `ANTHROPIC_*` из `.env.example`.

Запрос создаёт надёжное задание в SQLite, а фоновый worker выполняет не более одного вызова Anthropic одновременно. Временные ошибки повторяются с backoff, незавершённые задания восстанавливаются после перезапуска, устаревший результат не записывается поверх повторно захваченного контента. `TABHUB_DAILY_SUMMARY_LIMIT` ограничивает именно попытки вызова провайдера за UTC-день; расход токенов и расчётная стоимость сохраняются для каждой попытки и пишутся в лог успешного задания.

```powershell
$job = Invoke-RestMethod -Method Post `
  -Uri http://127.0.0.1:7717/api/tabs/1/summarize `
  -ContentType application/json `
  -Body '{"depth":"short"}'

Invoke-RestMethod "http://127.0.0.1:7717/api/jobs/$($job.jobId)"
```

Если ключ не настроен, endpoint возвращает `503 SUMMARY_PROVIDER_UNAVAILABLE` и не создаёт задание. В таблице UI у каждой вкладки с захваченным текстом доступно создание или обновление короткого summary; состояние очереди и ошибки показываются рядом с действием.

### Организация вкладок

Таблица поддерживает выбор строк и массовое изменение статуса либо назначение иерархического пути тега, например `Research/AI/Agents`. Сайдбар тем показывает дерево с накопительными счётчиками: фильтр по родительскому пути включает вкладки из всех дочерних тем. Клик по строке открывает карточку вкладки с контентом, summary, тегами, направленными связями, важностью и произвольными полями.

`PATCH /api/tabs/:id` принимает любую непустую комбинацию `status`, `importance` и `customFields`. Строковое значение создаёт или обновляет поле, `null` удаляет его. Массовая важность доступна через `PATCH /api/tabs/importance`. CRUD тем находится под `/api/tags`, назначение пути — `POST /api/tags/assign`, связи — под `/api/links`. Ручные изменения сохраняются с происхождением `user`, изменения MCP — `agent`.

## MCP для Claude Desktop и Codex

Сначала соберите stdio-сервер MCP и оставьте основной TabHub-сервер запущенным на `127.0.0.1:7717`:

```powershell
corepack pnpm --filter @tabhub/mcp build
corepack pnpm dev
```

MCP-процесс использует `TABHUB_API_URL` и остаётся тонким адаптером над REST API. Он предоставляет инструменты `list_tabs`, `get_tab`, `search_tabs`, `summarize_tab`, `set_status`, `set_importance`, `tag_tabs`, `link_tabs`, `list_tags`, `get_stats` и ресурс `tabhub://tab/{id}`. `summarize_tab` помечает запрос как агентский, ставит его в ту же SQLite-очередь и ожидает завершения до 55 секунд; если работа ещё не закончилась, повторный вызов продолжит ожидание того же активного задания. На этом этапе `search_tabs` выполняет полнотекстовый поиск; семантический режим добавляется на этапе 6. Контент в ответах MCP ограничен примерно 20 000 символами.

### Claude Desktop

Откройте **Settings → Developer → Edit Config**, добавьте сервер в `%APPDATA%\Claude\claude_desktop_config.json` и полностью перезапустите Claude Desktop:

```json
{
  "mcpServers": {
    "tabhub": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["D:\\VibeCoding\\TabHub\\packages\\mcp\\dist\\main.js"],
      "env": {
        "TABHUB_API_URL": "http://127.0.0.1:7717"
      }
    }
  }
}
```

Если Node.js или репозиторий находятся в другом месте, получите абсолютные пути командами `(Get-Command node).Source` и `(Resolve-Path packages/mcp/dist/main.js).Path` и замените значения выше.

### Codex

Добавьте сервер через CLI:

```powershell
codex mcp add tabhub --env TABHUB_API_URL=http://127.0.0.1:7717 -- 'C:\Program Files\nodejs\node.exe' 'D:\VibeCoding\TabHub\packages\mcp\dist\main.js'
codex mcp list
```

Эквивалентная ручная настройка в `%USERPROFILE%\.codex\config.toml`:

```toml
[mcp_servers.tabhub]
command = 'C:\Program Files\nodejs\node.exe'
args = ['D:\VibeCoding\TabHub\packages\mcp\dist\main.js']
cwd = 'D:\VibeCoding\TabHub'
startup_timeout_sec = 10
tool_timeout_sec = 60

[mcp_servers.tabhub.env]
TABHUB_API_URL = "http://127.0.0.1:7717"
```

После подключения откройте `/mcp` в Codex и убедитесь, что `tabhub` и десять инструментов доступны.

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
- Этап 2: ручной захват Readability-контента, FTS5 и поиск в UI — готово.
- Этап 3: REST-операции управления, иерархические теги, статистика и MCP-инструменты для Claude Desktop/Codex — готово.
- Этап 4: явная суммаризация через надёжную SQLite-очередь, последовательный Anthropic worker, UI и MCP — готово.
- Этап 5: дерево тем, карточка вкладки, связи, важность, custom fields и массовые операции в UI/MCP — готово.
- Этапы 6–7: см. [план реализации](./tab-manager-plan.md).
