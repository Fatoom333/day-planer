import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBackup, cleanTask, cleanSettings, isDate, ValidationError, DEFAULT_SETTINGS } from '../src/schema.js';

const task = (o = {}) => ({
  id: 't1', title: 'Отчёт', estimateMin: 60, priority: 2, category: 'учёба',
  splittable: false, status: 'todo', createdAt: 1_700_000_000_000, ...o,
});
const backup = (o = {}) => ({
  app: 'day-planer', version: 1, exportedAt: 1, tasks: [task()], history: [],
  days: [{ date: '2026-09-25', wakeAt: 600, order: ['t1'] }],
  settings: { ...DEFAULT_SETTINGS }, ...o,
});
const bad = (obj, re) => assert.throws(() => parseBackup(JSON.stringify(obj)), (e) => e instanceof ValidationError && re.test(e.message));

test('корректный бэкап проходит и сохраняет данные', () => {
  const r = parseBackup(JSON.stringify(backup()));
  assert.equal(r.tasks[0].title, 'Отчёт');
  assert.deepEqual(r.days[0].order, ['t1']);
  assert.equal(r.settings.bufferMin, 10);
});

test('лишние поля отбрасываются, включая __proto__', () => {
  const text = JSON.stringify(backup({ tasks: [task({ evil: '<img>', html: 'x' })] }))
    .replace('"evil"', '"__proto__":{"polluted":true},"evil"');
  const r = parseBackup(text);
  assert.deepEqual(Object.keys(r.tasks[0]).sort(), ['category', 'createdAt', 'estimateMin', 'id', 'priority', 'splittable', 'status', 'title']);
  assert.equal({}.polluted, undefined);
  assert.equal(r.tasks[0].polluted, undefined);
});

test('не JSON и чужой файл отклоняются', () => {
  assert.throws(() => parseBackup('{oops'), /не JSON/);
  bad({ ...backup(), app: 'other' }, /не бэкап/);
  bad({ ...backup(), version: 2 }, /версия/);
  bad([1, 2], /объект/);
});

test('слишком большой файл отклоняется до разбора', () => {
  assert.throws(() => parseBackup('x'.repeat(5_000_001)), /слишком большой/);
});

test('типы и диапазоны полей задачи', () => {
  bad(backup({ tasks: [task({ estimateMin: '60' })] }), /estimateMin/);
  bad(backup({ tasks: [task({ estimateMin: 0 })] }), /estimateMin/);
  bad(backup({ tasks: [task({ estimateMin: 1.5 })] }), /estimateMin/);
  bad(backup({ tasks: [task({ priority: 4 })] }), /priority/);
  bad(backup({ tasks: [task({ title: '' })] }), /title/);
  bad(backup({ tasks: [task({ title: '   ' })] }), /title/);
  bad(backup({ tasks: [task({ title: 'x'.repeat(201) })] }), /title/);
  bad(backup({ tasks: [task({ status: 'done' })] }), /status/);
  bad(backup({ tasks: [task({ id: '../x' })] }), /id/);
  bad(backup({ tasks: [task({ splittable: 'yes' })] }), /splittable/);
  bad(backup({ tasks: [task({ deadline: '2026-02-30' })] }), /deadline/);
  bad(backup({ tasks: [task({ notBefore: 'завтра' })] }), /notBefore/);
  bad(backup({ tasks: [task({ status: 'doing' })] }), /startedAt/);
});

test('история принимает только выполненные с finishedAt', () => {
  const done = task({ id: 'h1', status: 'done', finishedAt: 1_700_000_100_000, actualMin: 70 });
  assert.equal(parseBackup(JSON.stringify(backup({ history: [done] }))).history[0].actualMin, 70);
  bad(backup({ history: [task({ id: 'h1' })] }), /status/);
  bad(backup({ history: [{ ...done, finishedAt: undefined }] }), /finishedAt/);
});

test('повторы id и две задачи в работе отклоняются', () => {
  bad(backup({ tasks: [task(), task()] }), /повторяется id/);
  bad(backup({ tasks: [task(), task({ id: 't2' })], history: [task({ id: 't2', status: 'done', finishedAt: 1 })] }), /повторяется id/);
  const doing = (id) => task({ id, status: 'doing', startedAt: 1 });
  bad(backup({ tasks: [doing('a'), doing('b')] }), /больше одной/);
});

test('дни и настройки проверяются', () => {
  bad(backup({ days: [{ date: '25.09.2026' }] }), /date/);
  bad(backup({ days: [{ date: '2026-09-25', order: ['ok', 5] }] }), /order/);
  bad(backup({ days: [{ date: '2026-09-25' }, { date: '2026-09-25' }] }), /повторяется дата/);
  bad(backup({ settings: { ...DEFAULT_SETTINGS, bufferMin: 500 } }), /bufferMin/);
  bad(backup({ settings: { ...DEFAULT_SETTINGS, sleepAt: 1440 } }), /sleepAt/);
  bad(backup({ settings: undefined }), /settings/);
});

test('массивы ограничены по длине', () => {
  bad(backup({ tasks: Array.from({ length: 5001 }, (_, i) => task({ id: `t${i}` })) }), /больше 5000/);
});

test('cleanTask и cleanSettings годятся для ввода из форм', () => {
  assert.equal(cleanTask({ ...task(), splittable: undefined, category: undefined }).category, '');
  assert.deepEqual(cleanSettings({ defaultWake: 480, sleepAt: 60, bufferMin: 0 }).calendarIds, []);
  assert.ok(isDate('2028-02-29'));
  assert.ok(!isDate('2027-02-29'));
});
