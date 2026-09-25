// Сборка плана из сохранённых данных: переводит даты в минуты и зовёт ядро.
// Чистые функции, без DOM и хранилища.

import { orderTasks, computeFactors, planDay } from './plan.js';
import { dayKey, addDays, minutesOf, sleepMin } from './time.js';

const availableOn = (tasks, date) => tasks.filter((t) => !t.notBefore || t.notBefore <= date);

/**
 * План на сегодня.
 * @param {object} p
 *   now      — Date
 *   settings — {defaultWake, sleepAt, bufferMin}
 *   day      — DayState {date, wakeAt?, order?}; снимок порядка действует только в свой день
 *   tasks    — очередь (todo|doing)
 *   history  — выполненные, для поправки
 *   fixed    — пары сегодня [{start, end, title}] в минутах
 */
export function planToday({ now, settings, day, tasks, history, fixed = [] }) {
  const date = dayKey(now);
  const sameDay = day?.date === date;
  const nowMin = minutesOf(now, date);
  const factors = computeFactors(history);
  const ordered = orderTasks(availableOn(tasks, date), sameDay ? day.order ?? null : null);
  const doing = tasks.find((t) => t.status === 'doing');
  const running = doing ? { task: doing, startedAt: minutesOf(doing.startedAt, date) } : null;
  const wake = sameDay && day.wakeAt != null ? day.wakeAt : settings.defaultWake;
  const r = planDay(
    { wake, sleep: sleepMin(settings), now: nowMin, buffer: settings.bufferMin, gap: settings.gapMin, fixed, running },
    ordered,
    factors,
  );
  return { date, nowMin, wake, ordered, factors, ...r };
}

/**
 * Прогноз на 7 дней. День 0 — это planToday. Не влезшее в день N переходит в N+1;
 * задача с notBefore подмешивается в свой день; каждый следующий день — чистая авто-сортировка.
 * fixedByDate — {date: [{start, end, title}]}.
 */
export function planWeek({ now, settings, day, tasks, history, fixedByDate = {} }) {
  const today = planToday({ now, settings, day, tasks, history, fixed: fixedByDate[dayKey(now)] ?? [] });
  const out = [{ date: today.date, slots: today.slots, overflow: today.overflow, wake: today.wake }];
  let carry = today.overflow;
  for (let i = 1; i < 7; i++) {
    const date = addDays(today.date, i);
    const fresh = tasks.filter((t) => t.status !== 'doing' && t.notBefore === date);
    // Задачи с notBefore в прошлом уже попали в день 0; позже недели — не показываются.
    const queue = orderTasks([...carry, ...fresh]);
    const r = planDay(
      { wake: settings.defaultWake, sleep: sleepMin(settings), buffer: settings.bufferMin, gap: settings.gapMin, fixed: fixedByDate[date] ?? [] },
      queue,
      today.factors,
    );
    out.push({ date, slots: r.slots, overflow: r.overflow, wake: settings.defaultWake });
    carry = r.overflow;
  }
  const lastDate = out[6].date;
  const later = tasks.filter((t) => t.notBefore && t.notBefore > lastDate);
  return { days: out, overflow: carry, later, factors: today.factors };
}
