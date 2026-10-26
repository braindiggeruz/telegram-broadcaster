# TG Sender на Cloudflare Workers

Состояние на 26 октября 2026 года: **Supabase подключён, публикация и сквозная приёмка продолжаются**. Успешный вход через публичный Workers endpoint пока не подтверждён. `LIVE_SEND_ENABLED=false`. Адрес `https://tg-sender-v2.braindigger-uz.workers.dev` записан как origin; наличие конфигурации или deployment само по себе не подтверждает готовность сервиса.

## Архитектура и бюджет

Workers Assets обслуживает интерфейс; Workers HTTP adapter запускает существующий Express/tRPC API; минутный Cron обрабатывает сохранённую очередь. Источник данных — отдельный проект PostgreSQL в **Supabase Free**. Данные и расписания не зависят от включённого компьютера после фактического подключения и публикации этой схемы.

Цель — обойтись уже оплаченным Workers Paid без новых платных подписок. **$5 — минимальная плата за аккаунт, а не жёсткий предел счёта**: включённые квоты разделяются с другими проектами, превышение оплачивается отдельно. `cpu_ms=1000` ограничивает CPU отдельного invocation, но не месячное потребление аккаунта. До публикации проверяются оставшиеся квоты и настройки расходов. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

Supabase Free включает 500 MB базы, 1 GB файлового хранилища и 5 GB egress; допускает два активных проекта. Проекты могут приостанавливаться после недели неактивности, поэтому бесплатная БД **не даёт гарантии непрерывной доступности**. Перед созданием проверяется Free-план организации и свободное место для проекта. Pro, IPv4 add-on и другие платные опции для выбранной схемы не нужны и не включаются. [Supabase pricing](https://supabase.com/pricing).

Для соединения нужен direct PostgreSQL либо **session pool на 5432** с проверяемым TLS. Transaction pool на 6543 и Hyperdrive не подходят существующей очереди: session advisory lock удерживается через весь внешний вызов. Поддержку session locks и реальные права проверяют именно на выбранном endpoint. [Supabase connections](https://supabase.com/docs/guides/database/connecting-to-postgres), [Hyperdrive limitations](https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/).

### Защищённое соединение Workers с PostgreSQL

Для Workers выбран `DATABASE_TRANSPORT=supabase-relay`. Прямое соединение из workerd не прошло проверку цепочки CA Supabase; отключение проверки сертификата не используется. Вместо этого `server/supabaseRelay.ts` передаёт PostgreSQL protocol по защищённой WebSocket-сессии в отдельную Supabase Edge Function `supabase/functions/tg-postgres-relay/index.ts`.

Worker принимает только точный HTTPS endpoint `https://pdulckpafwbgpgotfzir.supabase.co/functions/v1/tg-postgres-relay`. В общем контракте имя проекта состоит из 20 строчных латинских букв; query, fragment, credentials в URL, явный порт и перенаправления отклоняются. Цель PostgreSQL также фиксирована: `aws-1-eu-central-1.pooler.supabase.com:5432`, база `postgres`, пользователь приложения `tg_sender_v2.<project-ref>`. Relay не предоставляет выбор произвольного хоста или transaction pool.

Edge Function развёртывается с `verify_jwt=true`. Worker передаёт anon JWT того же проекта в `Authorization` и отдельный `DATABASE_RELAY_TOKEN` в `x-tg-relay-token`. Token — 43-символьный base64url без padding: HMAC-SHA256 от UTF-8 строки `tg-sender:postgres-relay:v1`, ключ — Supabase service role key. Вычисление выполняется приватно при настройке; token передаётся через Cloudflare Secrets без вывода в журналы. Service role key остаётся в Supabase и backup-задаче, **в Worker и браузер он не передаётся**. Anon JWT сам по себе не даёт доступа к relay: Edge Function дополнительно проверяет HMAC. При ротации service role key требуется пересчитать relay token.

До HTTP upgrade функция открывает фиксированный PostgreSQL TCP socket, выполняет SSLRequest, `Deno.startTls` с hostname и доверенным CA Supabase, затем дожидается успешного TLS handshake. Только после этого принимает WebSocket. Внутренний `pg` stream использует `ssl:false` и отключённый channel binding исключительно внутри этой схемы: внешнее HTTPS/WSS и upstream PostgreSQL TLS проверяются на своих участках. Настройка `DATABASE_SSL=verify-full` сохраняется как требование политики, а не как обход проверки.

**Одна WebSocket-сессия соответствует одному PostgreSQL соединению**. Поток создаётся заново для каждого клиента пула; session advisory locks сохраняются до закрытия соединения. Прерванная сессия не переподключается автоматически и не продолжает неизвестную отправку. Соединения и поздно завершившиеся попытки закрываются при ошибке или таймауте. Срок жизни сессии ограничен 90 секундами; максимальный кадр — 3 MiB, локальная очередь — 8 MiB. Edge Function допускает до 12 одновременных соединений **на один isolate**, это не общий лимит проекта и не ограничение расходов. Cloudflare WebSocket не предоставляет подтверждения доставки `send()` или обычного stream backpressure; лимиты буферов и таймауты обязательны. [Workers WebSocket API](https://developers.cloudflare.com/workers/runtime-apis/websockets/).

Обычный Node/Docker runtime и `scripts/cloud-backup.ts` продолжают использовать прямой PostgreSQL TCP с проверяемым TLS. Для них `DATABASE_TRANSPORT` не задаётся либо равен `tcp`; relay bindings не нужны. Включать relay для `pg_dump` не следует.

## Что уже подготовлено в коде

| Часть           | Реализация                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP            | Общая фабрика `server/_core/app.ts`; Workers entrypoint `cloudflare/index.ts`; прежний Node entrypoint сохранён                                   |
| Статика         | Workers Assets, SPA fallback, заголовки CSP в `client/public/_headers`; `/api/*`, `/healthz`, `/readyz` идут в Worker                             |
| Соединения      | Отдельный PostgreSQL pool до трёх соединений на invocation; AsyncLocalStorage; закрытие после обработки всего HTTP body                           |
| Очередь         | Минутный Cron, до 30 обработок за batch, 40-секундный бюджет начала новых попыток; начатая попытка завершается с собственным timeout              |
| Защита доставки | Сохранённые паузы Telegram, блокировки отправителя, `inflight` и `unknown`; повтор Cron не означает повтор неизвестной отправки                   |
| MTProto login   | Зашифрованное промежуточное состояние в БД с TTL и лимитом попыток; Telegram-клиент не хранится между запросами                                   |
| Доступ          | Прежние cookie, авторизация, Origin/CSRF и webhook-проверки; только Workers entrypoint доверяет проверенным входным данным Cloudflare             |
| Бэкап           | Отдельный Node-скрипт `scripts/cloud-backup.ts` и workflow `.github/workflows/cloud-backup.yml`; дочерние процессы внутри Workers не используются |
| Supabase        | `scripts/secure-supabase.sql` включает RLS и закрывает прикладные таблицы от `PUBLIC`, `anon`, `authenticated`                                    |

Защита Supabase рассчитана **только на отдельный проект TG Sender**: SQL меняет права всех объектов `public`. Его нельзя применять к общей базе других приложений. После будущих миграций права и RLS проверяются повторно; default privileges зависят от роли, которая создаёт объекты.

`/healthz` подтверждает ответ API. `/readyz` требует доступную базу и свежий успешный цикл Cron; в scheduled-режиме допустимая давность — 120 секунд. При паузе базы или сбое Cron readiness возвращает 503. Успешная загрузка страницы не подтверждает готовность очереди.

## Сборка и проверка

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
pnpm build:cloudflare
```

`pnpm check` охватывает клиент, сервер, Workers entrypoint и облачный backup-скрипт. `pnpm build` сохраняет обычную Node-сборку. `pnpm build:cloudflare` собирает Assets и выполняет **Wrangler dry-run без публикации**; результат находится в `dist/cloudflare`. Production secrets для сборки не нужны, локальная `.env` не загружается сборочным скриптом.

Wrangler закреплён на `4.152.0`. `scripts/build-cloudflare.mjs` задаёт `WRANGLER_BUILD_PLATFORM=node`: browser resolution выбирает несовместимую ветку одной из зависимостей Express. Это настройка сборщика; runtime остаётся Workers. Используется совместимость Node и HTTP adapter с датой `2026-10-26`. [Workers HTTP compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/).

На Linux CI после сборки выполняется `node scripts/cloudflare-smoke.mjs`. Он принимает только loopback `TEST_DATABASE_URL`, создаёт отдельную случайную БД, применяет миграции, генерирует синтетические секреты и поднимает настоящий локальный workerd. Проверяются HTML/CSP, вход, cookie, параллельные запросы к БД, чужой Origin, две сухие доставки, повторные Cron и readiness. Временные секреты, база и процессы удаляются в конце. Telegram credentials не используются, реальные отправки выключены. Этот workflow ничего не развёртывает.

Проверенный коммит кода **`90bc045`** прошёл [Linux CI](https://github.com/braindiggeruz/telegram-broadcaster/actions/runs/40317073950): **160/160 тестов**, расширенный TypeScript check, Node/Workers build и **13/13 сквозных проверок настоящего workerd**, включая параллельные запросы и повторный Cron без дублей. Bundle: **2498.75 KiB, gzip 719.09 KiB**. [Контейнерный smoke](https://github.com/braindiggeruz/telegram-broadcaster/actions/runs/40317073975) также завершился успешно. Новый зашифрованный архив восстановлен локально в отдельную временную БД: **31 таблица и 14 миграций**; прежний архив также восстановлен новым кодом: **30 таблиц и 13 миграций**. Обе временные БД удалены. Эти результаты не заменяют проверку облачного endpoint, TLS и публичного HTTPS.

## Что остаётся для публикации

1. Подтвердить Free-план отдельного Supabase проекта, PostgreSQL-версию и права. Для Workers проверить TLS через защищённый relay, для Node backup — session/direct TCP endpoint. PostgreSQL 17 backup client требует совместимой версии сервера.
2. Применить миграции, затем `scripts/secure-supabase.sql`; проверить запрет доступа к прикладным таблицам через Data API. Существующие данные переносить только вместе с исходным ключом шифрования; новая пустая БД — отдельная установка.
3. Передать runtime secrets через Cloudflare Secrets: `DATABASE_URL`, `DATABASE_RELAY_TOKEN`, `DATABASE_RELAY_ANON_KEY`, `OWNER_OPEN_ID`, `OWNER_PASSWORD_HASH`, `SESSION_SECRET`, `ENCRYPTION_KEY`, `TELEGRAM_WEBHOOK_SECRET`. `DATABASE_TRANSPORT=supabase-relay` и точный `DATABASE_RELAY_URL` задаются конфигурацией Worker. Для прямого TCP backup отдельно передаются URL и доверенный `DATABASE_CA`. Для личного аккаунта дополнительно нужны собственные `TELEGRAM_API_ID` и `TELEGRAM_API_HASH`. Открытый пароль, токены и ключи не помещать в `wrangler.jsonc`, исходники, bundle или журналы.
4. Оставить `LIVE_SEND_ENABLED=false`, `WORKER_MODE=scheduled`, `DATABASE_SSL=verify-full`; проверить точный `APP_ORIGIN`. Опубликовать прошедшую проверки версию с той же настройкой `WRANGLER_BUILD_PLATFORM=node` и проверить фактический URL.
5. Подключить и проверить облачный бэкап по следующему разделу. Зафиксировать версию Worker, версию схемы и безопасный порядок отката.

Публичная приёмка: владелец входит, cookie защищена HTTPS, неавторизованный запрос и чужой Origin отклоняются; неподписанный webhook не принимается; сухая кампания доходит до отчёта, Cron повторяется без дублей, `/readyz` здоров после успешного цикла. Потеря invocation не должна превращать `unknown` в автоматическую повторную отправку. Настройка или live-подключение Telegram и реальная доставка этим deployment-планом не подтверждаются.

## Облачные резервные копии

Workflow `.github/workflows/cloud-backup.yml` подготовлен на **02:17 UTC ежедневно**, также есть `workflow_dispatch`. Он выполняет `pg_dump` PostgreSQL 17, шифрует архив, восстанавливает его в одноразовую локальную PostgreSQL на runner, отправляет в **приватный** bucket `tg-sender-backups` и сверяет скачанные байты по SHA-256. После успешной сверки сохраняются семь последних архивов; удаляются только архивы с именами этого приложения. Максимальный размер одного архива — 48 MiB. Превышение лимита завершает задачу ошибкой, не создаёт платное хранилище.

**Сейчас workflow не означает подключённое резервное копирование.** Нужны bucket, repository variable `CLOUD_BACKUPS_ENABLED=true` и GitHub Secrets:

- `CLOUD_DATABASE_URL`, при необходимости `CLOUD_DATABASE_CA`;
- `CLOUD_BACKUP_KEY_BASE64`, `CLOUD_ENCRYPTION_KEY`;
- `CLOUD_SUPABASE_URL`, `CLOUD_SUPABASE_SERVICE_ROLE_KEY`.

Service role key доступен только backup-задаче, не браузеру и не Worker API. Зависимости и системные пакеты устанавливаются до передачи production secrets. Ключ резервного копирования хранится отдельно от архивов и отличается от `ENCRYPTION_KEY`; без исходных ключей восстановить зашифрованные данные нельзя.

**GitHub запускает `schedule` только из default branch.** Наличие workflow в `codex/tg-sender-v2` само по себе расписание не включает. После настройки нужен успешный ручной прогон, затем подтверждённый плановый запуск; GitHub может задерживать задания, а в публичном репозитории расписание отключается после 60 дней без активности. Следить следует за `cloud_archive` в операционном статусе и результатом Actions, а не только за наличием файла workflow. [GitHub scheduled workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

Архивы и проверочное скачивание расходуют Supabase storage/egress; runner — доступные квоты GitHub Actions. Архив в том же Supabase-проекте защищает от ошибок приложения, но **не от удаления всего проекта или потери аккаунта**. Для такой аварии нужна отдельная защищённая копия архива и ключей вне проекта. Восстановление всегда выполняется в новую БД, при выключенных отправках.

## Сохранённый вариант Node/Docker

Обычный Node API + постоянный worker остаются рабочей архитектурой для собственного хоста. [Контейнерный runtime](DEPLOYMENT_RUNTIME_RU.md) сохранён как альтернатива; постоянно работающие Cloudflare Containers в текущую цель без новых расходов не входят.

Контейнерный commit `440ef12` ранее прошёл [Linux amd64 smoke](https://github.com/braindiggeruz/telegram-broadcaster/actions/runs/40308157863) и [обычный CI](https://github.com/braindiggeruz/telegram-broadcaster/actions/runs/40308157823): PostgreSQL 17, API/worker, интерфейс, вход, cookie и зашифрованный бэкап. Это доказательство конкретной сборки, а не текущего cloud deployment. После изменений требуется новый прогон для нового коммита.
