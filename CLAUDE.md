# day-planer

Динамический планер на день и неделю. Это PWA для телефона, ставится в Chrome как приложение. После каждого события («проснулся», «начал», «готово», «пропустил») он пересчитывает остаток дня и со временем учится на расхождении плана и факта. Полная спецификация — [SPEC.md](SPEC.md). Прочитай её перед любой задачей.

## Правила работы

- Отвечать **по-русски**.
- Вести работу короткими строками по ходу: одна строка до пачки вызовов (что и зачем), одна после (что вышло и что это меняет). Не выдавать длинные молчаливые серии вызовов.
- Статус проекта давать списком: сделано / открыто / в работе.
- Не соглашаться автоматически. Указывать на слабые места и спорить, если есть основания.
- Коммитить отдельными коммитами и **сразу пушить**, не спрашивая. Force-push и переписывание истории — только с явного согласия.
- В коммитах, PR и комментариях не ставить ссылку на сессию Claude (`Claude-Session: https://claude.ai/code/session_…`). `Co-Authored-By` оставлять.
- Менять поведение, зафиксированное в SPEC.md, только после согласия пользователя. Если в ходе работы решение изменилось, обнови SPEC.md в том же коммите.

## Решения (закреплены, не пересматривать без пользователя)

- Пересчёт делает детерминированный JS в `src/plan.js`, без LLM.
- Данные хранятся только на устройстве: IndexedDB, `navigator.storage.persist()`, экспорт/импорт JSON. Сервера нет.
- Хостинг — GitHub Pages из этого репо (ветка `main`, корень), адрес `https://fatoom333.github.io/day-planer/`. Все пути в коде относительные: сайт живёт не в корне домена. Репо публичный, поэтому в нём только код и никаких личных данных.
- Пары берутся из Google Calendar через Google Identity Services (token flow, scope `https://www.googleapis.com/auth/calendar.events.readonly`). Токен хранится только в памяти. Client ID лежит в `src/config.js`. Он публичный по природе (не секрет), а защиту даёт список разрешённых origin в Google Cloud. Client secret не нужен и в репо не попадает никогда.
- Порядок задач всегда автоматический: приоритет → дедлайн → дата добавления. Ручная перестановка действует до конца дня (`orderTasks(tasks, override)`). Новая задача встаёт после последней более важной или наверх.
- Задачи не дробятся, кроме тех, у которых стоит флажок `splittable` (куски не короче 25 минут, всё или ничего).
- Не влезло → планер **спрашивает**: завтра / в конец недели / удалить / уменьшить оценку. Молча не переносит.
- Стиль: спокойный, светлый, тёмная тема по `prefers-color-scheme`. Без фреймворков и без сборки: чистые ES-модули.

## Структура

- `src/plan.js` — ядро, чистые функции: `orderTasks`, `moveTask`, `computeFactors`, `forecast`, `planDay`, `planDays`. Время — минуты от полуночи.
- `test/plan.test.js` — тесты ядра.
- `src/schema.js` — схема данных и проверка импорта/ввода (`clean*`, `parseBackup`); `test/schema.test.js`.
- `src/store.js` — IndexedDB: tasks, history, days, meta, events (кэш пар, не экспортируется).
- `src/time.js` — логический день (граница 04:00), минуты по настенным часам, форматирование.
- `src/schedule.js` — `planToday`/`planWeek`: переводит сохранённые данные в вызовы ядра, учитывает `notBefore`; `test/schedule.test.js`.
- `src/dom.js` — `h()`, единственный способ строить DOM. `src/app.js` — UI четырёх экранов.
- `index.html`, `style.css`, `manifest.webmanifest`, `icons/`, `sw.js` (cache-first, **при изменении файлов поднимать `VERSION`**; `test/sw.test.js` проверяет, что все файлы в `FILES`).
- `docs/deploy.md` — выкладка на Pages и установка на телефон.
- `src/calendar.js` — GIS token flow (токен только в переменной модуля), загрузка недели пар, `groupByDay` (чистая, `test/calendar.test.js`). `src/config.js` — Client ID (сейчас заглушка).
- `docs/google-setup.md` — настройка Google Cloud для человека без опыта.

## Команды

- Тесты: `npm test` (Node 22+, зависимостей нет).
- Локальный просмотр: `python3 -m http.server 8000` из корня.
- Перед «готово»: `semgrep --metrics=off --config p/javascript --config p/xss --config p/secrets --config p/owasp-top-ten --config p/security-audit --exclude test .` (`--config auto` с `--metrics=off` не работает), `gitleaks dir .` и `gitleaks git .`. Если сканеров нет — сказать об этом, а не молчать.

## Безопасность (всегда)

- Данные пользователя и календаря выводятся только через `textContent` и `createElement`. Никакого `innerHTML`, `eval`, `new Function` и inline-обработчиков.
- CSP в `<meta>`: `default-src 'self'; script-src 'self' https://accounts.google.com/gsi/client; connect-src 'self' https://www.googleapis.com https://oauth2.googleapis.com; frame-src https://accounts.google.com; style-src 'self' https://accounts.google.com/gsi/style; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'`. Если GIS потребует больше, добавить минимум и объяснить почему.
  - `object-src`, `base-uri`, `form-action` не наследуются от `default-src` (кроме первого) — заданы явно. `form-action 'none'` не даёт формам уйти GET-запросом с названием задачи в URL, если JS не загрузился.
  - `https://oauth2.googleapis.com` добавлен ради `google.accounts.oauth2.revoke` (кнопка «Выйти»): GIS шлёт туда XHR. Телеметрия GIS на `accounts.google.com/gsi/log` намеренно заблокирована: даёт шум в консоли, на вход не влияет.
- Импорт JSON проверяется по схеме (типы, длины, диапазоны), лишние поля отбрасываются. Битый файл не должен ломать хранилище.
- Токен OAuth не пишется ни в IndexedDB, ни в localStorage, ни в лог.
- Новые зависимости — только с согласия пользователя.
- Перед тем как назвать работу готовой, сделать отдельный security-проход по диффу и сообщить, что проверено.
