// UI. Данные в DOM попадают только через h() (textContent / createElement).

import { h, $ } from './dom.js';
import * as store from './store.js';
import { cleanTask, ValidationError, LIMITS, MAX_IMPORT_BYTES } from './schema.js';
import { moveTask, forecast, orderTasks } from './plan.js';
import { planToday, planWeek } from './schedule.js';
import { dayKey, addDays, endOfWeek, fmt, fmtDur, fmtDate, parseHM, sleepMin, sleepValid } from './time.js';

const S = {
  settings: null,
  tasks: [],
  history: [],
  day: null,     // DayState текущего логического дня
  fixed: [],     // пары сегодня из кэша
  fixedByDate: {}, // пары на 7 дней из кэша
  date: null,
  plan: null,
  dragging: false,
};

// ── загрузка ────────────────────────────────────────────────────────────────

async function reload() {
  S.date = dayKey(new Date());
  const dates = Array.from({ length: 7 }, (_, i) => addDays(S.date, i));
  const [settings, tasks, history, day, ...evs] = await Promise.all([
    store.loadSettings(), store.getAll('tasks'), store.getAll('history'), store.getDay(S.date), ...dates.map(store.getEvents),
  ]);
  const fixedByDate = Object.fromEntries(dates.map((d, i) => [d, evs[i]?.events ?? []]));
  Object.assign(S, { settings, tasks, history, day, fixedByDate, fixed: fixedByDate[S.date] });
}

// Любое действие: записать, перечитать из базы, перерисовать. Ошибку показать, а не проглотить.
async function act(fn, msgEl = null) {
  try {
    await fn();
    if (msgEl) setMsg(msgEl, '');
  } catch (e) {
    const text = e instanceof ValidationError ? `Не сохранено: ${e.message}` : 'Не удалось сохранить. Попробуй ещё раз.';
    if (msgEl) setMsg(msgEl, text, true);
    else alert(text);
    if (!(e instanceof ValidationError)) console.error(e);
  }
  await reload();
  render();
}

function setMsg(el, text, err = false) {
  el.textContent = text;
  el.classList.toggle('err', err);
}

// ── действия ──────────────────────────────────────────────────────────────

const nowMin = () => S.plan?.nowMin ?? 0;
const doing = () => S.tasks.find((t) => t.status === 'doing');

const wake = () => act(() => store.saveDay({ ...S.day, date: S.date, wakeAt: planToday(ctx()).nowMin }));

const start = (t) => act(() => {
  if (doing()) return;
  return store.saveTask({ ...t, status: 'doing', startedAt: Date.now() });
});

const finish = (t) => act(() => {
  const now = Date.now();
  const actualMin = t.startedAt ? Math.min(LIMITS.actualMin, Math.max(1, Math.round((now - t.startedAt) / 60000))) : undefined;
  return store.completeTask({ ...t, finishedAt: now, actualMin });
});

// «Пропустить», «завтра», «в конец недели»: задача не планируется раньше даты.
const defer = (t, date) => act(() => store.saveTask({ ...t, status: 'todo', startedAt: undefined, notBefore: date }));

const remove = (t) => {
  if (!confirm(`Удалить «${t.title}»?`)) return;
  act(() => store.deleteTask(t.id));
};

const setEstimate = (t, n, msgEl) => act(() => store.saveTask({ ...t, estimateMin: n }), msgEl);

function reorder(id, targetId) {
  const idx = S.plan.ordered.findIndex((t) => t.id === targetId);
  if (idx < 0 || id === targetId) return;
  const order = moveTask(S.plan.ordered, id, idx);
  act(() => store.saveDay({ ...S.day, date: S.date, order }));
}

// ── Сегодня ───────────────────────────────────────────────────────────────

const ctx = () => ({ now: new Date(), settings: S.settings, day: S.day, tasks: S.tasks, history: S.history, fixed: S.fixed });

function renderToday() {
  const p = (S.plan = planToday(ctx()));
  $('#today-date').textContent = fmtDate(p.date);

  const wakeBox = $('#wake-box');
  if (S.day.wakeAt == null) {
    wakeBox.replaceChildren(h('button', { class: 'btn big primary', type: 'button', onclick: wake }, 'Проснулся'));
  } else {
    wakeBox.replaceChildren(h('p', { class: 'wake muted' }, `Подъём в ${fmt(S.day.wakeAt)}`));
  }

  const running = doing();
  const firstTodo = p.slots.find((s) => s.kind === 'task' && !s.running);
  const feed = p.slots.map((s) => (s.kind === 'fixed' ? fixedSlot(s) : taskCard(s, s === firstTodo, running)));
  $('#feed').replaceChildren(...(feed.length ? feed : [h('p', { class: 'empty' }, 'План пуст. Добавь задачу ниже.')]));

  $('#overflow').replaceChildren(...(p.overflow.length ? [overflowBlock(p)] : []));
}

const fixedSlot = (s) => h('div', { class: 'fixed-slot' },
  h('div', { class: 'small' }, `${fmt(s.start)}–${fmt(s.end)}`), s.title || 'Занято');

function taskCard(s, isNext, running) {
  const t = s.task;
  const meta = [`${fmt(s.start)}–${fmt(s.end)}`, s.running ? 'в работе' : fmtDur(s.end - s.start)];
  if (s.part) meta.push(`часть ${s.part[0]} из ${s.part[1]}`);
  if (t.deadline) meta.push(`до ${fmtDate(t.deadline)}`);
  if (t.category) meta.push(t.category);

  const card = h('article', {
    class: `card task-card${s.running ? ' running' : ''}${isNext ? ' next' : ''}`,
    dataset: s.running ? {} : { id: t.id },
  },
    h('div', { class: 'task-head' },
      h('div', { class: 'task-title' }, t.title),
      s.running ? null : h('button', { class: 'grip', type: 'button', 'aria-label': `Перетащить «${t.title}»`, title: 'Перетащить' }, '⋮⋮'),
    ),
    h('div', { class: 'task-meta' }, meta.join(' · ')),
  );

  // Кнопки — только на первом куске, чтобы у разделённой задачи не было дублей.
  if (!s.part || s.part[0] === 1) {
    const skip = h('button', { class: 'btn', type: 'button', onclick: () => defer(t, addDays(S.date, 1)) }, 'Пропустить');
    card.append(s.running
      ? h('div', { class: 'btns' }, h('button', { class: 'btn primary big', type: 'button', onclick: () => finish(t) }, 'Готово'), skip)
      : h('div', { class: 'btns' },
        h('button', { class: `btn${isNext ? ' primary' : ''}`, type: 'button', disabled: Boolean(running), onclick: () => start(t) }, 'Начать'),
        h('button', { class: 'btn', type: 'button', onclick: () => finish(t) }, 'Готово'),
        skip,
      ));
  }
  if (!s.running) attachDrag(card);
  return card;
}

function overflowBlock(p) {
  const items = p.overflow.map((t) => {
    const msg = h('p', { class: 'msg', role: 'status' });
    const input = h('input', { type: 'number', inputmode: 'numeric', min: 1, max: LIMITS.estimateMin, value: t.estimateMin, 'aria-label': 'Новая оценка, минут' });
    const reduce = h('form', { class: 'row', hidden: true, onsubmit: (e) => { e.preventDefault(); setEstimate(t, Number(input.value), msg); } },
      input, h('button', { class: 'btn primary', type: 'submit' }, 'OK'));
    return h('div', { class: 'overflow-item' },
      h('div', { class: 'task-title' }, t.title),
      h('div', { class: 'task-meta' }, `прогноз ${fmtDur(forecast(t, p.factors))} · оценка ${fmtDur(t.estimateMin)}`),
      h('div', { class: 'btns' },
        h('button', { class: 'btn', type: 'button', onclick: () => defer(t, addDays(S.date, 1)) }, 'Завтра'),
        h('button', { class: 'btn', type: 'button', onclick: () => defer(t, endOfWeek(S.date)) }, 'В конец недели'),
      ),
      h('div', { class: 'btns' },
        h('button', { class: 'btn', type: 'button', onclick: () => { reduce.hidden = !reduce.hidden; if (!reduce.hidden) input.focus(); } }, 'Уменьшить оценку'),
        h('button', { class: 'btn danger', type: 'button', onclick: () => remove(t) }, 'Удалить'),
      ),
      reduce, msg,
    );
  });
  return h('section', { class: 'card overflow', 'aria-label': 'Не влезает' }, h('h2', {}, `Не влезает сегодня: ${p.overflow.length}`), ...items);
}

// Перетаскивание за «⋮⋮»: pointer events работают и пальцем, и мышью.
// Брошенная на другую карточку задача занимает её место в очереди (moveTask → снимок дня).
function attachDrag(card) {
  const grip = card.querySelector('.grip');
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    S.dragging = true;
    const y0 = e.clientY, scroll0 = window.scrollY;
    let target = null, lastY = e.clientY, raf = 0;
    card.classList.add('dragging');

    const autoscroll = () => {
      const edge = 70, bottom = window.innerHeight - 70 - 60;
      const dy = lastY < edge ? -8 : lastY > bottom ? 8 : 0;
      if (dy) { window.scrollBy(0, dy); update(lastY); }
      raf = requestAnimationFrame(autoscroll);
    };
    const update = (y) => {
      card.style.transform = `translateY(${y - y0 + window.scrollY - scroll0}px)`;
      const under = document.elementsFromPoint(e.clientX, y).find((x) => x !== card && x.matches?.('.task-card[data-id]'));
      if (under !== target) {
        target?.classList.remove('drop-target');
        target = under ?? null;
        target?.classList.add('drop-target');
      }
    };
    const move = (ev) => { lastY = ev.clientY; update(ev.clientY); };
    const end = (ev) => {
      cancelAnimationFrame(raf);
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', end);
      grip.removeEventListener('pointercancel', end);
      card.classList.remove('dragging');
      card.style.transform = '';
      target?.classList.remove('drop-target');
      S.dragging = false;
      if (ev.type === 'pointerup' && target) reorder(card.dataset.id, target.dataset.id);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    raf = requestAnimationFrame(autoscroll);
  });
}

// ── Неделя ────────────────────────────────────────────────────────────────

function renderWeek() {
  const w = planWeek({ now: new Date(), settings: S.settings, day: S.day, tasks: S.tasks, history: S.history, fixedByDate: S.fixedByDate });
  const sleep = sleepMin(S.settings);
  const cards = w.days.map((d, i) => {
    const from = i === 0 ? Math.max(d.wake, S.plan?.nowMin ?? planToday(ctx()).nowMin) : d.wake;
    const fixedMin = d.slots.filter((s) => s.kind === 'fixed')
      .reduce((m, s) => m + Math.max(0, Math.min(s.end, sleep) - Math.max(s.start, from)), 0);
    const free = Math.max(0, sleep - from - fixedMin);
    const busy = d.slots.filter((s) => s.kind === 'task').reduce((m, s) => m + (s.end - Math.max(s.start, from)), 0);
    const fill = h('i');
    fill.style.width = `${free ? Math.min(100, Math.round((busy / free) * 100)) : 100}%`; // CSSOM, не атрибут style
    return h('section', { class: 'card day' },
      h('h2', {}, i === 0 ? `Сегодня, ${fmtDate(d.date)}` : fmtDate(d.date), h('span', { class: 'muted' }, `${fmtDur(busy)} из ${fmtDur(free)}`)),
      h('div', { class: `bar${busy >= free ? ' full' : ''}`, role: 'img', 'aria-label': `Загрузка ${fmtDur(busy)} из ${fmtDur(free)}` }, fill),
      d.slots.length
        ? h('ul', {}, d.slots.map((s) => h('li', { class: s.kind === 'fixed' ? 'fixed-li' : '' },
          h('span', { class: 'time' }, fmt(s.start)),
          h('span', {}, s.kind === 'fixed' ? s.title || 'Занято' : s.task.title, s.part ? ` (${s.part[0]}/${s.part[1]})` : ''))))
        : h('p', { class: 'muted' }, 'Свободно'),
    );
  });
  if (w.overflow.length) {
    cards.push(h('section', { class: 'card overflow' }, h('h2', {}, `Не влезает в неделю: ${w.overflow.length}`),
      h('ul', {}, w.overflow.map((t) => h('li', {}, `${t.title} · ${fmtDur(forecast(t, w.factors))}`)))));
  }
  if (w.later.length) {
    cards.push(h('section', { class: 'card' }, h('h2', {}, 'Отложено дальше недели'),
      h('ul', {}, w.later.map((t) => h('li', {}, `${t.title} · с ${fmtDate(t.notBefore)}`)))));
  }
  $('#week').replaceChildren(...cards);
}

// ── Задачи ────────────────────────────────────────────────────────────────

function taskFields(t = {}) {
  const pr = h('select', { name: 'priority' },
    h('option', { value: '1' }, '1 — важно'), h('option', { value: '2' }, '2 — обычно'), h('option', { value: '3' }, '3 — можно потом'));
  pr.value = String(t.priority ?? 2);
  return [
    h('label', { class: 'field' }, h('span', {}, 'Название'), h('input', { name: 'title', required: true, maxlength: LIMITS.title, value: t.title ?? '' })),
    h('div', { class: 'row' },
      h('label', { class: 'field' }, h('span', {}, 'Минут'), h('input', { name: 'estimateMin', type: 'number', inputmode: 'numeric', min: 1, max: LIMITS.estimateMin, required: true, value: t.estimateMin ?? 30 })),
      h('label', { class: 'field' }, h('span', {}, 'Приоритет'), pr)),
    h('label', { class: 'field' }, h('span', {}, 'Дедлайн'), h('input', { name: 'deadline', type: 'date', value: t.deadline ?? '' })),
    h('label', { class: 'field' }, h('span', {}, 'Категория'), h('input', { name: 'category', maxlength: LIMITS.category, list: 'categories', value: t.category ?? '' })),
    h('label', { class: 'check' }, h('input', { name: 'splittable', type: 'checkbox', checked: Boolean(t.splittable) }), 'Можно делить на куски от 25 минут'),
  ];
}

function renderTasks() {
  const sameDay = S.day?.date === S.date;
  const list = orderTasks(S.tasks, sameDay ? S.day.order ?? null : null);
  const factors = S.plan?.factors ?? {};
  const rows = list.map((t) => {
    const msg = h('p', { class: 'msg', role: 'status' });
    const form = h('form', { autocomplete: 'off' }, ...taskFields(t));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      let next;
      try { next = readTaskForm(form, t); } catch (err) { setMsg(msg, `Проверь поля: ${err.message}`, true); return; }
      act(() => store.saveTask(next), msg);
    });
    if (t.notBefore && t.notBefore > S.date) {
      form.append(h('p', { class: 'muted' }, `Отложена до ${fmtDate(t.notBefore)}. `,
        h('button', { class: 'btn', type: 'button', onclick: () => act(() => store.saveTask({ ...t, notBefore: undefined })) }, 'Вернуть в сегодня')));
    }
    form.append(msg, h('div', { class: 'btns' },
      h('button', { class: 'btn primary', type: 'submit' }, 'Сохранить'),
      h('button', { class: 'btn danger', type: 'button', onclick: () => remove(t) }, 'Удалить')));
    const tags = [fmtDur(forecast(t, factors)), `P${t.priority}`];
    if (t.status === 'doing') tags.unshift('в работе');
    if (t.notBefore && t.notBefore > S.date) tags.unshift(`с ${fmtDate(t.notBefore)}`);
    return h('details', { class: 'card task-row' },
      h('summary', {}, h('span', { class: 'task-title' }, t.title), h('span', { class: 'muted' }, tags.join(' · '))),
      form);
  });
  $('#tasks').replaceChildren(...(rows.length ? rows : [h('p', { class: 'empty' }, 'Задач нет. Добавь на экране «Сегодня».')]));
}

// ── Настройки ─────────────────────────────────────────────────────────────

function renderSettings() {
  const f = $('#settings-form');
  f.elements.defaultWake.value = fmt(S.settings.defaultWake);
  f.elements.sleepAt.value = fmt(S.settings.sleepAt);
  f.elements.bufferMin.value = String(S.settings.bufferMin);
}

function setupSettings() {
  const f = $('#settings-form');
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    const msg = $('#settings-msg');
    const next = {
      ...S.settings,
      defaultWake: parseHM(f.elements.defaultWake.value),
      sleepAt: parseHM(f.elements.sleepAt.value),
      bufferMin: Number(f.elements.bufferMin.value),
    };
    if (next.defaultWake == null || next.sleepAt == null) return setMsg(msg, 'Время в формате ЧЧ:ММ', true);
    if (!sleepValid(next)) return setMsg(msg, 'Сон после полуночи — не позже 04:00', true);
    act(async () => { await store.saveSettings(next); setMsg(msg, 'Сохранено'); });
  });

  $('#export').addEventListener('click', async () => {
    const msg = $('#backup-msg');
    try {
      const blob = new Blob([await store.exportBackup()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `day-planer-${S.date}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      setMsg(msg, 'Файл сохранён в загрузки');
    } catch (err) {
      console.error(err);
      setMsg(msg, 'Не удалось сделать экспорт', true);
    }
  });

  $('#import').addEventListener('change', async (e) => {
    const input = e.target, file = input.files?.[0], msg = $('#backup-msg');
    input.value = '';
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) return setMsg(msg, 'Файл слишком большой', true);
    if (!confirm('Импорт заменит все задачи, историю и настройки на этом телефоне. Продолжить?')) return;
    try {
      const r = await store.importBackup(await file.text());
      setMsg(msg, `Загружено: задач ${r.tasks}, в истории ${r.history}`);
    } catch (err) {
      setMsg(msg, err instanceof ValidationError ? `Файл не принят, данные не тронуты. ${err.message}` : 'Не удалось импортировать, данные не тронуты', true);
      if (!(err instanceof ValidationError)) console.error(err);
    }
    await reload();
    render();
  });
}

// ── быстрое добавление ────────────────────────────────────────────────────

function readTaskForm(form, base) {
  const f = new FormData(form);
  return cleanTask({
    ...base,
    title: String(f.get('title') ?? '').trim(),
    estimateMin: Number(f.get('estimateMin')),
    priority: Number(f.get('priority')),
    deadline: f.get('deadline') || undefined,
    category: String(f.get('category') ?? '').trim(),
    splittable: f.get('splittable') === 'on',
  });
}

function setupQuickAdd() {
  const form = $('#quick-add');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const msg = $('#add-msg');
    let t;
    try {
      t = readTaskForm(form, { id: crypto.randomUUID(), status: 'todo', createdAt: Date.now() });
    } catch (err) {
      setMsg(msg, err instanceof ValidationError ? `Проверь поля: ${err.message}` : 'Ошибка', true);
      return;
    }
    act(async () => {
      await store.saveTask(t);
      form.reset();
      form.querySelector('details').open = false;
    }, msg);
  });
}

function renderCategories() {
  const cats = [...new Set([...S.tasks, ...S.history].map((t) => t.category).filter(Boolean))].sort();
  $('#categories').replaceChildren(...cats.map((c) => h('option', { value: c })));
}

// ── маршрутизация и отрисовка ─────────────────────────────────────────────

const TABS = ['today', 'week', 'tasks', 'settings'];
const VIEWS = { today: renderToday, week: renderWeek, tasks: renderTasks, settings: renderSettings };
const tab = () => (TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'today');

function render() {
  const cur = tab();
  for (const name of TABS) {
    $(`#view-${name}`).hidden = name !== cur;
    const a = $(`.tabs a[data-tab="${name}"]`);
    if (name === cur) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  renderCategories();
  if (cur !== 'today') S.plan = planToday(ctx()); // nowMin и поправка нужны и другим экранам
  VIEWS[cur]();
}

// Раз в полминуты план пересчитывается от нового «сейчас». Не мешаем, пока человек
// тащит карточку или печатает в поле внутри перерисовываемой области.
async function tick() {
  if (S.dragging) return;
  const active = document.activeElement;
  if (active?.matches?.('input, select') && active.closest('#feed, #overflow')) return;
  if (dayKey(new Date()) !== S.date) await reload();
  // «Задачи» и «Настройки» — формы; их перерисовка по таймеру закрывала бы раскрытую правку.
  if (tab() === 'today' || tab() === 'week') render();
}

// Просим браузер не чистить хранилище. В Chrome согласие даётся без диалога,
// обычно после установки приложения на главный экран.
async function persistStorage() {
  const el = $('#storage-msg');
  if (!navigator.storage?.persist) return setMsg(el, 'Браузер не умеет защищать хранилище — делай экспорт почаще.');
  const ok = (await navigator.storage.persisted()) || (await navigator.storage.persist());
  setMsg(el, ok
    ? 'Хранилище защищено: браузер не удалит данные сам.'
    : 'Браузер пока может очистить данные при нехватке места. Установи приложение на главный экран и делай экспорт.');
}

async function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch((e) => console.error('SW', e));
  await reload();
  persistStorage().catch(() => {});
  setupQuickAdd();
  setupSettings();
  window.addEventListener('hashchange', render);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  setInterval(tick, 30000);
  render();
}

init().catch((e) => {
  console.error(e);
  document.body.prepend(h('p', { class: 'card msg err' }, 'Не удалось открыть хранилище. Проверь, что браузер не в режиме инкогнито, и перезапусти приложение.'));
});
