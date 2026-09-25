// Схема данных и проверка всего, что приходит извне (импорт JSON, ввод в формах).
// Каждая функция clean* строит НОВЫЙ объект только из известных полей: лишние поля
// (включая "__proto__" и "constructor") отбрасываются, типы и диапазоны проверяются.

export const APP_ID = 'day-planer';
export const SCHEMA_VERSION = 1;
export const MAX_IMPORT_BYTES = 5_000_000;

export const LIMITS = {
  title: 200,
  category: 50,
  estimateMin: 1440,
  actualMin: 10080,
  bufferMin: 120,
  tasks: 5000,
  history: 20000,
  days: 5000,
  calendarIds: 20,
  calendarId: 256,
};

const MAX_TS = 4102444800000; // 2100-01-01
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const DEFAULT_SETTINGS = Object.freeze({
  defaultWake: 8 * 60,
  sleepAt: 23 * 60,
  bufferMin: 10,
  gapMin: 10,
  calendarIds: Object.freeze(['primary']),
});

export class ValidationError extends Error {}

function fail(path, msg) {
  throw new ValidationError(`${path}: ${msg}`);
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function isDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function str(v, path, max, { min = 0, re = null } = {}) {
  if (typeof v !== 'string') fail(path, 'ожидалась строка');
  if (v.length < min || v.length > max) fail(path, `длина вне ${min}…${max}`);
  if (re && !re.test(v)) fail(path, 'недопустимый формат');
  return v;
}

function int(v, path, min, max) {
  if (!Number.isInteger(v)) fail(path, 'ожидалось целое число');
  if (v < min || v > max) fail(path, `вне диапазона ${min}…${max}`);
  return v;
}

function date(v, path) {
  if (!isDate(v)) fail(path, 'ожидалась дата ГГГГ-ММ-ДД');
  return v;
}

function arr(v, path, max) {
  if (!Array.isArray(v)) fail(path, 'ожидался массив');
  if (v.length > max) fail(path, `больше ${max} элементов`);
  return v;
}

const ts = (v, path) => int(v, path, 0, MAX_TS);
const id = (v, path) => str(v, path, 64, { min: 1, re: ID_RE });

/** Задача. statuses — какие статусы допустимы в этом месте (очередь или история). */
export function cleanTask(t, path = 'task', statuses = ['todo', 'doing']) {
  if (!isObj(t)) fail(path, 'ожидался объект');
  const title = str(t.title, `${path}.title`, LIMITS.title, { min: 1 });
  if (!title.trim()) fail(`${path}.title`, 'пустое название');
  if (!statuses.includes(t.status)) fail(`${path}.status`, `ожидалось ${statuses.join('|')}`);
  if (t.splittable !== undefined && typeof t.splittable !== 'boolean') fail(`${path}.splittable`, 'ожидалось true/false');
  const out = {
    id: id(t.id, `${path}.id`),
    title,
    estimateMin: int(t.estimateMin, `${path}.estimateMin`, 1, LIMITS.estimateMin),
    priority: int(t.priority, `${path}.priority`, 1, 3),
    category: t.category === undefined ? '' : str(t.category, `${path}.category`, LIMITS.category),
    splittable: t.splittable === true,
    status: t.status,
    createdAt: ts(t.createdAt, `${path}.createdAt`),
  };
  if (t.deadline != null) out.deadline = date(t.deadline, `${path}.deadline`);
  if (t.notBefore != null) out.notBefore = date(t.notBefore, `${path}.notBefore`);
  if (t.startedAt != null) out.startedAt = ts(t.startedAt, `${path}.startedAt`);
  if (t.finishedAt != null) out.finishedAt = ts(t.finishedAt, `${path}.finishedAt`);
  if (t.actualMin != null) out.actualMin = int(t.actualMin, `${path}.actualMin`, 1, LIMITS.actualMin);
  if (out.status === 'doing' && out.startedAt == null) fail(`${path}.startedAt`, 'у задачи в работе нет начала');
  if (out.status === 'done' && out.finishedAt == null) fail(`${path}.finishedAt`, 'у выполненной задачи нет конца');
  return out;
}

/** Состояние дня: фактический подъём и снимок ручного порядка. Минуты от полуночи логического дня. */
export function cleanDay(d, path = 'day') {
  if (!isObj(d)) fail(path, 'ожидался объект');
  const out = { date: date(d.date, `${path}.date`) };
  if (d.wakeAt != null) out.wakeAt = int(d.wakeAt, `${path}.wakeAt`, 0, 2880);
  if (d.order != null) out.order = arr(d.order, `${path}.order`, LIMITS.tasks).map((x, i) => id(x, `${path}.order[${i}]`));
  return out;
}

export function cleanSettings(s, path = 'settings') {
  if (!isObj(s)) fail(path, 'ожидался объект');
  const ids = arr(s.calendarIds ?? [], `${path}.calendarIds`, LIMITS.calendarIds)
    .map((x, i) => str(x, `${path}.calendarIds[${i}]`, LIMITS.calendarId, { min: 1 }));
  return {
    defaultWake: int(s.defaultWake, `${path}.defaultWake`, 0, 1439),
    sleepAt: int(s.sleepAt, `${path}.sleepAt`, 0, 1439),
    bufferMin: int(s.bufferMin, `${path}.bufferMin`, 0, LIMITS.bufferMin),
    // Поле появилось позже: в старых настройках и бэкапах его нет — берём значение по умолчанию.
    gapMin: s.gapMin === undefined ? DEFAULT_SETTINGS.gapMin : int(s.gapMin, `${path}.gapMin`, 0, LIMITS.bufferMin),
    calendarIds: ids,
  };
}

/** Проверка бэкапа целиком. Любая ошибка — исключение, частичного импорта нет. */
export function cleanBackup(b) {
  if (!isObj(b)) fail('файл', 'ожидался объект');
  if (b.app !== APP_ID) fail('app', 'это не бэкап day-planer');
  if (b.version !== SCHEMA_VERSION) fail('version', `поддерживается только версия ${SCHEMA_VERSION}`);
  const tasks = arr(b.tasks, 'tasks', LIMITS.tasks).map((t, i) => cleanTask(t, `tasks[${i}]`));
  const history = arr(b.history, 'history', LIMITS.history).map((t, i) => cleanTask(t, `history[${i}]`, ['done']));
  const days = arr(b.days, 'days', LIMITS.days).map((d, i) => cleanDay(d, `days[${i}]`));
  const settings = cleanSettings(b.settings);

  const seen = new Set();
  for (const t of [...tasks, ...history]) {
    if (seen.has(t.id)) fail('tasks', `повторяется id ${t.id}`);
    seen.add(t.id);
  }
  if (tasks.filter((t) => t.status === 'doing').length > 1) fail('tasks', 'в работе больше одной задачи');
  const dates = new Set();
  for (const d of days) {
    if (dates.has(d.date)) fail('days', `повторяется дата ${d.date}`);
    dates.add(d.date);
  }
  return { tasks, history, days, settings };
}

/** Текст файла → проверенные данные. Бросает ValidationError с понятным сообщением. */
export function parseBackup(text) {
  if (typeof text !== 'string') fail('файл', 'ожидался текст');
  if (text.length > MAX_IMPORT_BYTES) fail('файл', 'слишком большой');
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    fail('файл', 'это не JSON');
  }
  return cleanBackup(raw);
}
