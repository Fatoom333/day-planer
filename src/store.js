// Хранилище на IndexedDB. Всё живёт только на устройстве.
// tasks   — очередь (todo|doing), ключ id
// history — выполненные задачи, из них считается поправка, ключ id
// days    — {date, wakeAt?, order?}: подъём и снимок ручного порядка на день, ключ date
// meta    — настройки под ключом 'settings'
// events  — кэш пар из календаря {date, events[], fetchedAt}, ключ date; в экспорт не идёт

import { APP_ID, SCHEMA_VERSION, DEFAULT_SETTINGS, cleanTask, cleanDay, cleanSettings, parseBackup } from './schema.js';

const DB_NAME = 'day-planer';
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('tasks', { keyPath: 'id' });
      db.createObjectStore('history', { keyPath: 'id' });
      db.createObjectStore('days', { keyPath: 'date' });
      db.createObjectStore('meta');
      db.createObjectStore('events', { keyPath: 'date' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const wrap = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

// Выполняет fn внутри одной транзакции; промис разрешается после commit.
async function tx(names, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(names, mode);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error('транзакция прервана'));
    Promise.resolve(fn(...names.map((n) => t.objectStore(n)))).then((r) => { result = r; }, (e) => { t.abort(); reject(e); });
  });
}

export const getAll = (store) => tx([store], 'readonly', (s) => wrap(s.getAll()));
export const get = (store, key) => tx([store], 'readonly', (s) => wrap(s.get(key)));

export async function loadSettings() {
  const s = await get('meta', 'settings');
  try {
    return s ? cleanSettings(s) : { ...DEFAULT_SETTINGS, calendarIds: [...DEFAULT_SETTINGS.calendarIds] };
  } catch {
    return { ...DEFAULT_SETTINGS, calendarIds: [...DEFAULT_SETTINGS.calendarIds] };
  }
}

// Запись всегда через clean*: в базу не попадает то, что потом не пройдёт импорт.
export const saveSettings = (s) => tx(['meta'], 'readwrite', (m) => wrap(m.put(cleanSettings(s), 'settings')));
export const saveTask = (t) => tx(['tasks'], 'readwrite', (s) => wrap(s.put(cleanTask(t))));
export const deleteTask = (id) => tx(['tasks'], 'readwrite', (s) => wrap(s.delete(id)));
export const saveDay = (d) => tx(['days'], 'readwrite', (s) => wrap(s.put(cleanDay(d))));
export const getDay = async (date) => (await get('days', date)) ?? { date };

// Готово: задача уходит из очереди в историю одной транзакцией.
export function completeTask(t) {
  const done = cleanTask({ ...t, status: 'done' }, 'task', ['done']);
  return tx(['tasks', 'history'], 'readwrite', (tasks, history) => {
    tasks.delete(done.id);
    history.put(done);
  });
}

// Кэш пар: только start/end/title, минуты логического дня.
export const saveEvents = (date, events) =>
  tx(['events'], 'readwrite', (s) => wrap(s.put({ date, events, fetchedAt: Date.now() })));
export const getEvents = (date) => get('events', date);

export async function exportBackup() {
  const [tasks, history, days, settings] = await Promise.all([
    getAll('tasks'), getAll('history'), getAll('days'), loadSettings(),
  ]);
  return JSON.stringify({ app: APP_ID, version: SCHEMA_VERSION, exportedAt: Date.now(), tasks, history, days, settings }, null, 1);
}

// Импорт заменяет всё. Сначала полная проверка, потом одна транзакция: ошибка — ничего не меняется.
export async function importBackup(text) {
  const data = parseBackup(text);
  await tx(['tasks', 'history', 'days', 'meta'], 'readwrite', (tasks, history, days, meta) => {
    tasks.clear(); history.clear(); days.clear();
    data.tasks.forEach((t) => tasks.put(t));
    data.history.forEach((t) => history.put(t));
    data.days.forEach((d) => days.put(d));
    meta.put(data.settings, 'settings');
  });
  return { tasks: data.tasks.length, history: data.history.length };
}
