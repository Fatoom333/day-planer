// Ядро планера: чистые функции без DOM и хранилища.
// Время внутри дня — минуты от полуночи (0…1440). Перевод дат в минуты делает вызывающий код.

export const MIN_CHUNK = 25;
const OVERRUN_GRACE = 10; // сколько ещё держать задачу, если её прогноз уже истёк

// ── Порядок ───────────────────────────────────────────────────────────────

// Авто-ключ: приоритет → дедлайн (раньше выше, без дедлайна — в конце) → дата добавления.
// Просроченные отдельно не поднимаются: неважная просрочка остаётся ниже важного.
export function autoCompare(a, b) {
  if (a.priority !== b.priority) return a.priority - b.priority;
  const da = a.deadline ?? '9999-12-31';
  const db = b.deadline ?? '9999-12-31';
  if (da !== db) return da < db ? -1 : 1;
  return a.createdAt - b.createdAt;
}

/**
 * Порядок укладки. По умолчанию — авто-ключ.
 * override — ручной порядок на сегодня (массив id, снимок после перетаскивания) или null.
 * Задачи из снимка идут в его порядке; задача вне снимка встаёт сразу после последней,
 * которая по ключу важнее её (или наверх, если важнее нет). Поднятое вручную остаётся
 * выше всего, что добавится менее важным. Снимок живёт только в пределах дня —
 * это решает вызывающий код, передавая null на новый день.
 */
export function orderTasks(tasks, override = null) {
  const auto = tasks.slice().sort(autoCompare);
  if (!override) return auto;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out = override.filter((id) => byId.has(id)).map((id) => byId.get(id));
  const pinned = new Set(out.map((t) => t.id));
  for (const t of auto) {
    if (pinned.has(t.id)) continue;
    let last = -1; // последняя задача, важнее новой; если таких нет — новая встаёт наверх
    out.forEach((o, j) => { if (autoCompare(o, t) < 0) last = j; });
    out.splice(last + 1, 0, t);
  }
  return out;
}

// Перетаскивание: возвращает новый снимок порядка на сегодня.
export function moveTask(ordered, id, toIndex) {
  const ids = ordered.map((t) => t.id).filter((x) => x !== id);
  ids.splice(Math.max(0, Math.min(toIndex, ids.length)), 0, id);
  return ids;
}

// ── Поправка на прошлое ───────────────────────────────────────────────────

const HISTORY = 20;
const MIN_POINTS = 5;

function median(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// done: завершённые задачи с actualMin и finishedAt. Возвращает {категория: множитель}.
export function computeFactors(done) {
  const byCat = {};
  for (const t of done) {
    if (!(t.estimateMin > 0) || !(t.actualMin > 0)) continue;
    (byCat[t.category ?? ''] ??= []).push(t);
  }
  const out = {};
  for (const [cat, list] of Object.entries(byCat)) {
    const recent = list.sort((a, b) => b.finishedAt - a.finishedAt).slice(0, HISTORY);
    if (recent.length < MIN_POINTS) continue;
    const f = median(recent.map((t) => t.actualMin / t.estimateMin));
    out[cat] = Math.min(2.5, Math.max(0.5, f));
  }
  return out;
}

export function forecast(task, factors = {}) {
  return Math.max(1, Math.round(task.estimateMin * (factors[task.category ?? ''] ?? 1)));
}

// ── Укладка дня ─────────────────────────────────────────────────────────────

// Вычитает занятые интервалы из окна. busy может пересекаться и быть неотсортирован.
function freeGaps(start, end, busy) {
  const sorted = busy
    .map(([s, e]) => [Math.max(s, start), Math.min(e, end)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  const gaps = [];
  let cur = start;
  for (const [s, e] of sorted) {
    if (s > cur) gaps.push([cur, s]);
    cur = Math.max(cur, e);
  }
  if (end > cur) gaps.push([cur, end]);
  return gaps;
}

function placeWhole(gaps, need) {
  const i = gaps.findIndex(([s, e]) => e - s >= need);
  if (i === -1) return null;
  const [s, e] = gaps[i];
  gaps[i] = [s + need, e];
  return [[s, s + need]];
}

function placeSplit(gaps, need) {
  const trial = gaps.map((g) => g.slice());
  const pieces = [];
  let left = need;
  for (const g of trial) {
    if (left === 0) break;
    const len = g[1] - g[0];
    const take = Math.min(len, left);
    if (take < MIN_CHUNK && take < left) continue; // кусок короче 25 мин — только последний остаток
    pieces.push([g[0], g[0] + take]);
    g[0] += take;
    left -= take;
  }
  if (left > 0) return null; // всё или ничего: частично уложенная задача путает
  trial.forEach((g, i) => (gaps[i] = g));
  return pieces;
}

/**
 * @param {object} day
 *   wake, sleep       — границы дня (минуты)
 *   now               — текущее время, или null для будущего дня
 *   buffer            — минуты вокруг пар
 *   fixed             — [{start, end, title}] пары из календаря
 *   running           — {task, startedAt} задача в работе, или null
 * @param {object[]} tasks — невыполненные задачи в порядке укладки (см. orderTasks)
 * @param {object} factors — из computeFactors
 * @returns {{slots: object[], overflow: object[]}}
 */
export function planDay(day, tasks, factors = {}) {
  const { wake, sleep, now = null, buffer = 10, fixed = [], running = null } = day;
  const start = now == null ? wake : Math.max(wake, now);
  const slots = [];
  const busy = [];

  for (const f of fixed) {
    slots.push({ kind: 'fixed', start: f.start, end: f.end, title: f.title });
    busy.push([f.start - buffer, f.end + buffer]);
  }

  if (running && now != null) {
    const end = Math.max(running.startedAt + forecast(running.task, factors), now + OVERRUN_GRACE);
    slots.push({ kind: 'task', running: true, start: running.startedAt, end, task: running.task });
    busy.push([now, end]);
  }

  const gaps = freeGaps(start, sleep, busy);
  const overflow = [];

  for (const task of tasks) {
    if (running && task.id === running.task.id) continue;
    const need = forecast(task, factors);
    const pieces = task.splittable ? placeSplit(gaps, need) : placeWhole(gaps, need);
    if (!pieces) {
      overflow.push(task);
      continue;
    }
    pieces.forEach(([s, e], i) =>
      slots.push({ kind: 'task', start: s, end: e, task, part: pieces.length > 1 ? [i + 1, pieces.length] : null }),
    );
  }

  slots.sort((a, b) => a.start - b.start);
  return { slots, overflow };
}

// Прогноз на несколько дней: что не влезло в день N, переходит в день N+1.
export function planDays(days, tasks, factors = {}) {
  let rest = tasks;
  return days.map((day) => {
    const r = planDay(day, rest, factors);
    rest = r.overflow;
    return r;
  });
}
