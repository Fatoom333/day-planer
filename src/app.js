// UI. Данные в DOM попадают только через h() (textContent / createElement).

import { h, $ } from './dom.js';
import * as store from './store.js';
import { cleanTask, ValidationError, LIMITS } from './schema.js';
import { moveTask, forecast } from './plan.js';
import { planToday } from './schedule.js';
import { dayKey, addDays, endOfWeek, fmt, fmtDur, fmtDate } from './time.js';

const S = {
  settings: null,
  tasks: [],
  history: [],
  day: null,     // DayState текущего логического дня
  fixed: [],     // пары сегодня из кэша
  date: null,
  plan: null,
  dragging: false,
};

// ── загрузка ────────────────────────────────────────────────────────────────

async function reload() {
  S.date = dayKey(new Date());
  const [settings, tasks, history, day, ev] = await Promise.all([
    store.loadSettings(), store.getAll('tasks'), store.getAll('history'), store.getDay(S.date), store.getEvents(S.date),
  ]);
  Object.assign(S, { settings, tasks, history, day, fixed: ev?.events ?? [] });
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
const VIEWS = { today: renderToday };
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
  VIEWS[cur]?.();
}

// Раз в полминуты план пересчитывается от нового «сейчас». Не мешаем, пока человек
// тащит карточку или печатает в поле внутри перерисовываемой области.
async function tick() {
  if (S.dragging) return;
  const active = document.activeElement;
  if (active?.matches?.('input, select') && active.closest('#feed, #overflow, #tasks, #settings-form')) return;
  if (dayKey(new Date()) !== S.date) await reload();
  render();
}

async function init() {
  await reload();
  setupQuickAdd();
  window.addEventListener('hashchange', render);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  setInterval(tick, 30000);
  render();
}

init().catch((e) => {
  console.error(e);
  document.body.prepend(h('p', { class: 'card msg err' }, 'Не удалось открыть хранилище. Проверь, что браузер не в режиме инкогнито, и перезапусти приложение.'));
});
