import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayKey, minutesOf, addDays, endOfWeek, sleepMin, sleepValid, fmt, parseHM } from '../src/time.js';
import { planToday, planWeek } from '../src/schedule.js';

const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi);
const settings = { defaultWake: 8 * 60, sleepAt: 23 * 60, bufferMin: 10, gapMin: 0, calendarIds: [] };
let seq = 0;
const task = (o) => ({ id: `t${++seq}`, title: 'x', estimateMin: 60, priority: 2, category: '', status: 'todo', createdAt: seq, ...o });
const titles = (r) => r.slots.filter((s) => s.kind === 'task').map((s) => s.task.title);

test('граница дня 04:00: в 02:00 ещё вчера, минуты за 1440', () => {
  assert.equal(dayKey(at(2026, 9, 26, 2)), '2026-09-25');
  assert.equal(dayKey(at(2026, 9, 26, 4)), '2026-09-26');
  assert.equal(minutesOf(at(2026, 9, 26, 1, 30), '2026-09-25'), 1440 + 90);
  assert.equal(minutesOf(at(2026, 9, 25, 9), '2026-09-26'), 9 * 60 - 1440);
});

test('даты: addDays через месяц, конец недели — ближайшее воскресенье', () => {
  assert.equal(addDays('2026-09-29', 3), '2026-10-02');
  assert.equal(endOfWeek('2026-09-25'), '2026-09-27'); // пт → вс
  assert.equal(endOfWeek('2026-09-27'), '2026-10-04'); // вс → следующее вс
});

test('сон после полуночи и проверка настроек', () => {
  assert.equal(sleepMin({ defaultWake: 480, sleepAt: 60 }), 1500);
  assert.equal(sleepMin(settings), 1380);
  assert.ok(sleepValid({ defaultWake: 480, sleepAt: 240 }));
  assert.ok(!sleepValid({ defaultWake: 480, sleepAt: 300 }));
  assert.equal(fmt(1500), '01:00');
  assert.equal(parseHM('07:05'), 425);
  assert.equal(parseHM('24:00'), null);
});

test('после полуночи с поздним сном задачи ещё планируются', () => {
  const s = { ...settings, sleepAt: 2 * 60 };
  const r = planToday({ now: at(2026, 9, 26, 0, 30), settings: s, day: null, tasks: [task({ title: 'a' })], history: [] });
  assert.equal(r.date, '2026-09-25');
  assert.equal(r.slots[0].start, 1440 + 30);
});

test('notBefore прячет задачу сегодня и показывает в свой день недели', () => {
  const now = at(2026, 9, 25, 9);
  const later = task({ title: 'потом', notBefore: '2026-09-27' });
  const r = planToday({ now, settings, day: null, tasks: [later, task({ title: 'сейчас' })], history: [] });
  assert.deepEqual(titles(r), ['сейчас']);
  const w = planWeek({ now, settings, day: null, tasks: [later], history: [] });
  assert.deepEqual(w.days.map((d) => titles(d).length), [0, 0, 1, 0, 0, 0, 0]);
});

test('notBefore в прошлом не мешает, дальше недели — в later', () => {
  const now = at(2026, 9, 25, 9);
  const old = task({ title: 'старое', notBefore: '2026-09-01' });
  const far = task({ title: 'далеко', notBefore: '2026-12-01' });
  const w = planWeek({ now, settings, day: null, tasks: [old, far], history: [] });
  assert.deepEqual(titles(w.days[0]), ['старое']);
  assert.deepEqual(w.later.map((t) => t.title), ['далеко']);
});

test('снимок ручного порядка действует только в свой день', () => {
  const a = task({ title: 'a', priority: 1 }), b = task({ title: 'b', priority: 3 });
  const day = { date: '2026-09-25', order: [b.id, a.id] };
  assert.deepEqual(titles(planToday({ now: at(2026, 9, 25, 9), settings, day, tasks: [a, b], history: [] })), ['b', 'a']);
  assert.deepEqual(titles(planToday({ now: at(2026, 9, 26, 9), settings, day, tasks: [a, b], history: [] })), ['a', 'b']);
});

test('подъём из DayState сдвигает начало, чужой день игнорируется', () => {
  const t = task({});
  const r = planToday({ now: at(2026, 9, 25, 7), settings, day: { date: '2026-09-25', wakeAt: 6 * 60 + 50 }, tasks: [t], history: [] });
  assert.equal(r.slots[0].start, 7 * 60);
  const r2 = planToday({ now: at(2026, 9, 25, 7), settings, day: { date: '2026-09-24', wakeAt: 400 }, tasks: [t], history: [] });
  assert.equal(r2.slots[0].start, 8 * 60);
});

test('задача в работе: startedAt в мс превращается в минуты дня', () => {
  const t = task({ status: 'doing', startedAt: at(2026, 9, 25, 9).getTime() });
  const r = planToday({ now: at(2026, 9, 25, 9, 20), settings, day: null, tasks: [t], history: [] });
  const run = r.slots.find((s) => s.running);
  assert.deepEqual([run.start, run.end], [540, 600]);
  assert.equal(r.overflow.length, 0);
});

test('неделя переносит не влезшее на следующий день по авто-ключу', () => {
  const s = { ...settings, defaultWake: 9 * 60, sleepAt: 11 * 60 };
  const tasks = [task({ title: 'a', estimateMin: 120 }), task({ title: 'b', estimateMin: 120 }), task({ title: 'c', estimateMin: 120, priority: 1, notBefore: '2026-09-26' })];
  const w = planWeek({ now: at(2026, 9, 25, 8), settings: s, day: null, tasks, history: [] });
  assert.deepEqual(w.days.slice(0, 4).map(titles), [['a'], ['c'], ['b'], []]);
});

test('между задачами пауза из gapMin, отдельно от буфера пар', () => {
  const r = planToday({ now: at(2026, 9, 25, 7), settings: { ...settings, bufferMin: 30, gapMin: 15 }, day: null, tasks: [task({ title: 'a' }), task({ title: 'b' })], history: [] });
  assert.deepEqual(r.slots.map((s) => s.start), [8 * 60, 9 * 60 + 15]);
});
