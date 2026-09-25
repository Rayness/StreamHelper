# StreamHelper

Десктоп-приложение для стримеров (Windows, Electron + TypeScript): всё для трансляции в одном окне.

- **Объединённый чат** — сообщения с эмоутами Twitch/7TV/BTTV/FFZ и значками, ответы, удаление, таймаут, бан.
- **Алерты** — фоллоу, подписки, продления, подарочные подписки, битсы, рейды, донаты, награды за баллы. Свои звуки, картинки/видео, анимации, пороги сумм, озвучка (TTS), очередь с паузой и пропуском.
- **Оверлеи для OBS** (Browser Source): алерты, чат, лента событий, цели, таймеры (обратный отсчёт, секундомер, сабатон).
- **Чат-бот** — свои команды с переменными и кулдаунами, встроенные команды (`!аптайм`, `!followage`, `!title`, `!game`, `!so`, `!count`, `!permit`), таймерные сообщения, счётчики, автомодерация (ссылки, капс, запрещённые слова, спам), реакции на события.
- **Управление трансляцией** — название и категория Twitch, сцены/источники/звук/стрим/запись OBS, кнопки быстрых действий и глобальные горячие клавиши.
- **Донаты** — DonationAlerts и Streamlabs.
- Интерфейс на русском и английском.

Платформы: сейчас Twitch. YouTube, VK Play Live и Kick подключаются через интерфейс `ChatPlatform` ([src/main/platforms/types.ts](src/main/platforms/types.ts)).

## Перед первым релизом: регистрация приложений

Приложение ходит в API от имени зарегистрированных клиентов. Их нужно создать один раз (автору приложения, а не каждому стримеру) и вписать Client ID в [src/shared/defaults.ts](src/shared/defaults.ts):

| Сервис | Где создать | Настройки | Куда вписать |
|---|---|---|---|
| Twitch | https://dev.twitch.tv/console/apps | Client Type: **Public**, OAuth Redirect URL: `http://localhost` | `DEFAULT_TWITCH_CLIENT_ID` |
| DonationAlerts | https://www.donationalerts.com/application/clients | Redirect URI: `http://127.0.0.1:4848/auth/donationalerts` | `DEFAULT_DA_CLIENT_ID` |

Пока константы пустые, Client ID можно ввести прямо в приложении (Подключения / Настройки → Дополнительно).

Секреты приложений не нужны: Twitch — Device Code Flow для публичных клиентов, DonationAlerts — Implicit Grant. Streamlabs не требует регистрации: стример вставляет свой Socket API Token.

## Разработка

```bash
npm install
npm run dev          # приложение с hot reload
npm test             # тесты (vitest)
npm run typecheck
npm run dist         # установщик Windows в dist/
```

Подводные камни окружения:
- Если `npm install` не скачал Electron (`Error: Electron uninstall`), выполните `node node_modules/electron/install.js`.
- Терминал VS Code выставляет `ELECTRON_RUN_AS_NODE=1`, и Electron стартует как голый Node (`electron.app` undefined). Запускайте из обычного терминала или сбросьте переменную: `env -u ELECTRON_RUN_AS_NODE npm run dev` (PowerShell: `Remove-Item Env:ELECTRON_RUN_AS_NODE`).

## Архитектура

```
src/
  shared/       типы (события, настройки, IPC-контракт), шаблоны, дефолты — общие для main, UI и оверлеев
  main/         Electron main process
    core/       шина событий, настройки (JSON), секреты (safeStorage/DPAPI), состояние подключений
    platforms/  ChatPlatform + Twitch: Device Code OAuth, Helix, EventSub WebSocket, нормализация событий
    donations/  DonationAlerts (OAuth + Centrifugo), Streamlabs (socket.io v2)
    obs/        obs-websocket v5
    bot/        команды, кулдауны, права, модерация, таймеры
    features/   очередь алертов, цели/таймеры/сабатон, действия и глобальные хоткеи, история чата
    overlay/    локальный HTTP+WS сервер (127.0.0.1:4848) для оверлеев и OAuth-колбэка
  preload/      мост window.api
  renderer/     React UI
resources/overlays/  оверлеи для OBS (чистые HTML/JS)
tests/          unit + интеграционные тесты (фейковые серверы OBS и EventSub, моки Helix)
```

Поток данных: платформы и донат-сервисы нормализуют всё в `ChatMessage` / `StreamEvent` и публикуют в `EventBus`. На шину подписаны бот, очередь алертов, цели/сабатон, хаб оверлеев и UI — ни один из них не знает, откуда пришло событие.

Файлы пользователя лежат в `%APPDATA%/StreamHelper`: `settings.json` (настройки), `secrets.bin` (токены, зашифрованы DPAPI), `media/` (звуки и картинки алертов).
