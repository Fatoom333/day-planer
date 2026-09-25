import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planDay, planDays, computeFactors, forecast, orderTasks, moveTask,
} from '../src/plan.js';

const h = (hh, mm = 0) => hh * 60 + mm;
let seq = 0;
const task = (o) => ({ id: `t${++seq}`, title: o.title ?? 'x', estimateMin: 60, priority: 2, createdAt: seq, ...o });
const taskSlots = (r) => r.slots.filter((s) => s.kind === 'task');

test('пустой день: задачи идут подряд с подъёма', () => {
  const a = task({ estimateMin: 60 }), b = task({ estimateMin: 30 });
  const r = planDay({ wake: h(8), sleep: h(23) }, [a, b]);
  assert.deepEqual(taskSlots(r).map((s) => [s.start, s.end]), [[h(8), h(9)], [h(9), h(9, 30)]]);
  assert.equal(r.overflow.length, 0);
});

test('проспал: день начинается с now, хвост уходит в overflow', () => {
  const tasks = [task({ estimateMin: 120 }), task({ estimateMin: 120 })];
  const r = planDay({ wake: h(8), sleep: h(14), now: h(11) }, tasks);
  assert.equal(taskSlots(r)[0].start, h(11));
  assert.deepEqual(r.overflow.map((t) => t.id), [tasks[1].id]);
});

test('пара посреди дня с буфером: задача не лезет в окно и уходит после пары, окно заполняет меньшая', () => {
  const big = task({ estimateMin: 90 }), small = task({ estimateMin: 30 });
  const fixed = [{ start: h(10), end: h(11, 30), title: 'Матан' }];
  const r = planDay({ wake: h(9), sleep: h(20), buffer: 10, fixed }, [big, small]);
  const byId = Object.fromEntries(taskSlots(r).map((s) => [s.task.id, s]));
  assert.equal(byId[big.id].start, h(11, 40)); // 11:30 + буфер
  assert.equal(byId[small.id].start, h(9)); // окно 9:00–9:50 заполнила меньшая
  assert.ok(r.slots.some((s) => s.kind === 'fixed' && s.title === 'Матан'));
});

test('сделал быстрее: следующая задача сдвигается на now', () => {
  const next = task({ estimateMin: 60 });
  const r = planDay({ wake: h(8), sleep: h(22), now: h(9, 20) }, [next]);
  assert.equal(taskSlots(r)[0].start, h(9, 20));
});

test('задача затянулась: держит время до now+10, остальное сдвигается', () => {
  const cur = task({ estimateMin: 60 }), next = task({ estimateMin: 30 });
  const r = planDay(
    { wake: h(8), sleep: h(22), now: h(10), running: { task: cur, startedAt: h(8, 30) } },
    [cur, next],
  );
  const run = r.slots.find((s) => s.running);
  assert.equal(run.end, h(10, 10));
  assert.equal(taskSlots(r).find((s) => s.task.id === next.id).start, h(10, 10));
});

test('задача в работе в срок: занимает до startedAt + прогноз', () => {
  const cur = task({ estimateMin: 60 });
  const r = planDay({ wake: h(8), sleep: h(22), now: h(9), running: { task: cur, startedAt: h(8, 30) } }, [cur]);
  assert.equal(r.slots.find((s) => s.running).end, h(9, 30));
  assert.equal(taskSlots(r).length, 1);
});

test('ничего не влезает — всё в overflow, пары остаются', () => {
  const tasks = [task({ estimateMin: 200 })];
  const r = planDay({ wake: h(8), sleep: h(10), fixed: [{ start: h(8, 30), end: h(9, 30), title: 'П' }] }, tasks);
  assert.equal(taskSlots(r).length, 0);
  assert.equal(r.overflow.length, 1);
});

test('дробимая задача режется по окнам, окна короче 25 мин пропускаются', () => {
  const t = task({ estimateMin: 110, splittable: true }); // 80 + остаток 30 > окна 20
  const fixed = [
    { start: h(9, 20), end: h(10), title: 'A' }, // окно 8:00–9:20 = 80
    { start: h(10, 20), end: h(12), title: 'B' }, // окно 10:00–10:20 = 20 → пропуск
  ];
  const r = planDay({ wake: h(8), sleep: h(20), buffer: 0, fixed }, [t]);
  const parts = taskSlots(r);
  assert.deepEqual(parts.map((s) => [s.start, s.end]), [[h(8), h(9, 20)], [h(12), h(12, 30)]]);
  assert.deepEqual(parts.map((s) => s.part), [[1, 2], [2, 2]]);
});

test('дробимая, которая целиком не влезает — не кладётся частично', () => {
  const t = task({ estimateMin: 300, splittable: true });
  const r = planDay({ wake: h(8), sleep: h(10) }, [t]);
  assert.equal(taskSlots(r).length, 0);
  assert.equal(r.overflow.length, 1);
});

test('неделя: не влезшее переходит на следующий день', () => {
  const tasks = [task({ estimateMin: 120 }), task({ estimateMin: 120 }), task({ estimateMin: 120 })];
  const day = { wake: h(8), sleep: h(12) };
  const [d1, d2] = planDays([day, day], tasks);
  assert.equal(taskSlots(d1).length, 2);
  assert.equal(taskSlots(d2).length, 1);
  assert.equal(d2.overflow.length, 0);
});

test('поправка: медиана по категории, нужно ≥5 точек, ограничение 0.5…2.5', () => {
  const mk = (cat, est, act, n) => Array.from({ length: n }, (_, i) =>
    ({ category: cat, estimateMin: est, actualMin: act, finishedAt: i }));
  const f = computeFactors([...mk('учёба', 60, 96, 5), ...mk('дом', 60, 30, 4), ...mk('x', 10, 100, 6)]);
  assert.equal(f['учёба'], 1.6);
  assert.equal(f['дом'], undefined);
  assert.equal(f.x, 2.5);
  assert.equal(forecast({ estimateMin: 60, category: 'учёба' }, f), 96);
  assert.equal(forecast({ estimateMin: 60, category: 'дом' }, f), 60);
});

test('поправка берёт только последние 20', () => {
  const old = Array.from({ length: 20 }, (_, i) => ({ category: 'c', estimateMin: 10, actualMin: 20, finishedAt: i }));
  const fresh = Array.from({ length: 20 }, (_, i) => ({ category: 'c', estimateMin: 10, actualMin: 10, finishedAt: 100 + i }));
  assert.equal(computeFactors([...old, ...fresh]).c, 1);
});

test('авто-порядок: просроченная неважная ёлка ниже важного ДЗ', () => {
  const tree = task({ title: 'ёлка', priority: 3, deadline: '2026-09-18' });
  const hw = task({ title: 'ДЗ', priority: 1, deadline: '2026-09-28' });
  assert.deepEqual(orderTasks([tree, hw]).map((t) => t.title), ['ДЗ', 'ёлка']);
});

test('авто-порядок: при равном приоритете раньше дедлайн, без дедлайна в конце', () => {
  const a = task({ priority: 2 }), b = task({ priority: 2, deadline: '2026-10-05' }), c = task({ priority: 2, deadline: '2026-09-30' });
  assert.deepEqual(orderTasks([a, b, c]).map((t) => t.id), [c.id, b.id, a.id]);
});

test('ручная правка на сегодня: снимок соблюдается, новая задача встаёт по ключу', () => {
  const a = task({ priority: 1 }), b = task({ priority: 3 });
  const snap = moveTask(orderTasks([a, b]), b.id, 0); // вручную b наверх
  assert.deepEqual(snap, [b.id, a.id]);
  const c = task({ priority: 2 }); // новая: встаёт после последней более важной (a), b остаётся наверху
  assert.deepEqual(orderTasks([a, b, c], snap).map((t) => t.id), [b.id, a.id, c.id]);
  const top = task({ priority: 1, deadline: '2026-09-26' }); // важнее всех, что есть → наверх
  assert.deepEqual(orderTasks([a, b, top], snap).map((t) => t.id), [top.id, b.id, a.id]);
  assert.deepEqual(orderTasks([a, b, c], null).map((t) => t.id), [a.id, c.id, b.id]); // новый день
});

test('ручная правка: выполненные/удалённые задачи из снимка просто выпадают', () => {
  const a = task({}), b = task({});
  assert.deepEqual(orderTasks([b], [a.id, b.id]).map((t) => t.id), [b.id]);
});

test('последний остаток короче 25 мин может занять короткое окно', () => {
  const t = task({ estimateMin: 100, splittable: true });
  const fixed = [{ start: h(9, 20), end: h(10), title: 'A' }, { start: h(10, 20), end: h(12), title: 'B' }];
  const r = planDay({ wake: h(8), sleep: h(20), buffer: 0, fixed }, [t]);
  assert.deepEqual(taskSlots(r).map((s) => [s.start, s.end]), [[h(8), h(9, 20)], [h(10), h(10, 20)]]);
});

test('пауза gap между задачами; хвостовая пауза обрезается о буфер пары и сон', () => {
  const a = task({ estimateMin: 60 }), b = task({ estimateMin: 60 }), c = task({ estimateMin: 30 });
  const fixed = [{ start: h(11, 20), end: h(12), title: 'Пара' }];
  const r = planDay({ wake: h(9), sleep: h(13), buffer: 10, gap: 10, fixed }, [a, b, c]);
  const at = Object.fromEntries(taskSlots(r).map((s) => [s.task.id, [s.start, s.end]]));
  assert.deepEqual(at[a.id], [h(9), h(10)]);
  assert.deepEqual(at[b.id], [h(10, 10), h(11, 10)]); // впритык к буферу пары, без второй паузы
  assert.deepEqual(at[c.id], [h(12, 10), h(12, 40)]);
});

test('gap после задачи в работе и между кусками разделённой', () => {
  const cur = task({ estimateMin: 60 }), next = task({ estimateMin: 30 });
  const r = planDay({ wake: h(8), sleep: h(22), now: h(9), gap: 15, running: { task: cur, startedAt: h(8, 30) } }, [cur, next]);
  assert.equal(taskSlots(r).find((s) => s.task.id === next.id).start, h(9, 45));
  const sp = task({ estimateMin: 60, splittable: true }), after = task({ estimateMin: 20 });
  const fixed = [{ start: h(9), end: h(10), title: 'Пара' }];
  const r2 = planDay({ wake: h(8), sleep: h(12), buffer: 0, gap: 10, fixed }, [sp, after]);
  const parts = taskSlots(r2).filter((s) => s.task.id === sp.id).map((s) => [s.start, s.end]);
  assert.deepEqual(parts, [[h(8), h(9)]]); // целиком влезла до пары, пауза съелась о пару
  assert.equal(taskSlots(r2).find((s) => s.task.id === after.id).start, h(10));
});
