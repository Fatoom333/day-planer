import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupByDay, isConfigured } from '../src/calendar.js';

const iso = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString();
const ev = (s, e, o = {}) => ({ summary: 'Матан', start: { dateTime: s }, end: { dateTime: e }, ...o });

test('заглушка Client ID не считается настройкой', () => {
  assert.equal(isConfigured(), false);
});

test('события раскладываются по логическим дням в минутах', () => {
  const r = groupByDay([
    ev(iso(2026, 9, 26, 9), iso(2026, 9, 26, 10, 30)),
    ev(iso(2026, 9, 28, 13), iso(2026, 9, 28, 14, 30), { summary: 'Линал' }),
  ], '2026-09-26');
  assert.equal(Object.keys(r).length, 7);
  assert.deepEqual(r['2026-09-26'], [{ start: 540, end: 630, title: 'Матан' }]);
  assert.equal(r['2026-09-28'][0].title, 'Линал');
  assert.deepEqual(r['2026-09-27'], []);
});

test('пропускаются отменённые, свободные, весь день, вне недели и битые', () => {
  const r = groupByDay([
    ev(iso(2026, 9, 26, 9), iso(2026, 9, 26, 10), { status: 'cancelled' }),
    ev(iso(2026, 9, 26, 11), iso(2026, 9, 26, 12), { transparency: 'transparent' }),
    { summary: 'ДР', start: { date: '2026-09-26' }, end: { date: '2026-09-27' } },
    ev(iso(2026, 10, 20, 9), iso(2026, 10, 20, 10)),
    ev('not a date', iso(2026, 9, 26, 10)),
    ev(iso(2026, 9, 26, 12), iso(2026, 9, 26, 11)),
    null, 'x', { start: 5 },
  ], '2026-09-26');
  assert.equal(Object.values(r).flat().length, 0);
});

test('ночное событие до 04:00 относится к вчера, длинное обрезается', () => {
  const r = groupByDay([ev(iso(2026, 9, 27, 1), iso(2026, 9, 27, 9))], '2026-09-26');
  assert.deepEqual(r['2026-09-26'], [{ start: 1500, end: 1680, title: 'Матан' }]);
});

test('название обрезается, не-строка даёт пустое название', () => {
  const r = groupByDay([
    ev(iso(2026, 9, 26, 9), iso(2026, 9, 26, 10), { summary: 'x'.repeat(500) }),
    ev(iso(2026, 9, 26, 11), iso(2026, 9, 26, 12), { summary: { html: '<b>' } }),
  ], '2026-09-26');
  assert.equal(r['2026-09-26'][0].title.length, 200);
  assert.equal(r['2026-09-26'][1].title, '');
});

test('не больше 50 пар в день и не массив на входе', () => {
  const many = Array.from({ length: 80 }, (_, i) => ev(iso(2026, 9, 26, 5, i), iso(2026, 9, 26, 5, i + 1)));
  assert.equal(groupByDay(many, '2026-09-26')['2026-09-26'].length, 50);
  assert.equal(Object.values(groupByDay({ items: 1 }, '2026-09-26')).flat().length, 0);
});

test('одно и то же событие из двух календарей — одна пара', () => {
  const e = ev(iso(2026, 9, 26, 9), iso(2026, 9, 26, 10));
  assert.equal(groupByDay([e, { ...e }], '2026-09-26')['2026-09-26'].length, 1);
});
