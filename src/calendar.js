// Пары из Google Calendar через Google Identity Services (token flow).
// Токен живёт только в переменной этого модуля: не пишется ни в хранилище, ни в лог,
// пропадает при закрытии приложения. Scope — только чтение событий.

import { GOOGLE_CLIENT_ID } from './config.js';
import { dayKey, minutesOf, addDays, DAY_BOUNDARY } from './time.js';

export const SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';
const GIS_SRC = 'https://accounts.google.com/gsi/client';
const API = 'https://www.googleapis.com/calendar/v3/calendars/';
const DAYS = 7;
const MAX_TITLE = 200;
const MAX_PER_DAY = 50;
const MAX_PAGES = 5;

export class CalendarError extends Error {}

export const isConfigured = () => /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(GOOGLE_CLIENT_ID);

let token = null; // {value, exp}
let gisPromise = null;

export const signedIn = () => Boolean(token && Date.now() < token.exp - 60000);

// Скрипт GIS грузится только когда нужен: без календаря приложение не ходит к Google вовсе.
export function loadGis() {
  gisPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.addEventListener('load', () => resolve());
    s.addEventListener('error', () => {
      gisPromise = null;
      s.remove();
      reject(new CalendarError('Не загрузился вход Google. Нужна сеть.'));
    });
    document.head.append(s);
  });
  return gisPromise;
}

const ERRORS = {
  popup_closed: 'Окно входа закрыто.',
  popup_failed_to_open: 'Браузер не открыл окно входа. Разреши всплывающие окна.',
  access_denied: 'Доступ к календарю не дан.',
};

// Вызывать из обработчика нажатия: окно входа открывается только по жесту пользователя.
export async function getToken() {
  if (signedIn()) return token.value;
  await loadGis();
  const oauth2 = window.google?.accounts?.oauth2;
  if (!oauth2) throw new CalendarError('Вход Google недоступен.');
  return new Promise((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPE,
      callback: (r) => {
        if (r?.error) return reject(new CalendarError(ERRORS[r.error] ?? 'Вход не удался.'));
        if (!r?.access_token || !oauth2.hasGrantedAllScopes(r, SCOPE)) {
          return reject(new CalendarError('Нужно разрешить чтение календаря.'));
        }
        const ttl = Math.min(Number(r.expires_in) || 0, 3600);
        token = { value: r.access_token, exp: Date.now() + ttl * 1000 };
        resolve(token.value);
      },
      error_callback: (e) => reject(new CalendarError(ERRORS[e?.type] ?? 'Вход не удался.')),
    });
    client.requestAccessToken({ prompt: '' });
  });
}

// «Выйти»: отзываем доступ у Google и забываем токен.
export function signOut() {
  const t = token?.value;
  token = null;
  if (t) window.google?.accounts?.oauth2?.revoke(t, () => {});
}

const localAt = (key, min) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, 0, min);
};

const parseTime = (v) => {
  if (typeof v !== 'string' || v.length > 40) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Ответ Google → {date: [{start, end, title}]} на DAYS дней от startDate, в минутах логического дня.
 * Ответ считается недоверенным: берём только нужные поля и проверяем типы.
 * Пропускаем отменённые, «свободные» и события на весь день (у них нет времени).
 */
export function groupByDay(items, startDate) {
  const out = {};
  for (let i = 0; i < DAYS; i++) out[addDays(startDate, i)] = [];
  for (const ev of Array.isArray(items) ? items : []) {
    if (!ev || typeof ev !== 'object' || ev.status === 'cancelled' || ev.transparency === 'transparent') continue;
    const s = parseTime(ev.start?.dateTime), e = parseTime(ev.end?.dateTime);
    if (!s || !e || e <= s) continue;
    const key = dayKey(s);
    if (!out[key] || out[key].length >= MAX_PER_DAY) continue;
    const start = minutesOf(s, key);
    const end = Math.min(minutesOf(e, key), 1440 + DAY_BOUNDARY);
    if (end <= start) continue;
    const title = typeof ev.summary === 'string' ? ev.summary.slice(0, MAX_TITLE) : '';
    // Одно событие бывает в двух календарях (расшаренное расписание) — показываем один раз.
    if (out[key].some((x) => x.start === start && x.end === end && x.title === title)) continue;
    out[key].push({ start, end, title });
  }
  for (const list of Object.values(out)) list.sort((a, b) => a.start - b.start);
  return out;
}

async function fetchCalendar(id, tok, timeMin, timeMax) {
  const items = [];
  let pageToken = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({
      timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '250',
      fields: 'items(summary,start,end,status,transparency),nextPageToken',
    });
    if (pageToken) q.set('pageToken', pageToken);
    const res = await fetch(`${API}${encodeURIComponent(id)}/events?${q}`, {
      headers: { Authorization: `Bearer ${tok}` },
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
    if (res.status === 401) {
      token = null;
      throw new CalendarError('Вход устарел. Нажми «Загрузить пары» ещё раз.');
    }
    if (res.status === 403 || res.status === 404) throw new CalendarError(`Календарь «${id}» не найден или нет доступа.`);
    if (!res.ok) throw new CalendarError(`Google ответил ошибкой ${res.status}.`);
    const data = await res.json();
    if (Array.isArray(data?.items)) items.push(...data.items);
    pageToken = typeof data?.nextPageToken === 'string' ? data.nextPageToken : '';
    if (!pageToken) break;
  }
  return items;
}

/** Пары на неделю из всех календарей. Нужен сетевой доступ и вход. */
export async function fetchWeek(startDate, calendarIds) {
  const tok = await getToken();
  const timeMin = localAt(startDate, DAY_BOUNDARY).toISOString();
  const timeMax = localAt(addDays(startDate, DAYS), DAY_BOUNDARY).toISOString();
  const all = [];
  for (const id of calendarIds) all.push(...await fetchCalendar(id, tok, timeMin, timeMax));
  return groupByDay(all, startDate);
}
