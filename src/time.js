// Логический день и перевод времени в минуты. Граница дня — 04:00: до неё ещё «вчера»,
// и минуты продолжают расти за 1440. Минуты считаются по настенным часам, а не по мс,
// чтобы в день перевода часов время на экране совпадало с часами телефона.

export const DAY_BOUNDARY = 4 * 60;

const pad = (n) => String(n).padStart(2, '0');
const localKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const utcOf = (key) => { const [y, m, d] = key.split('-').map(Number); return Date.UTC(y, m - 1, d); };

// Логическая дата момента: 'ГГГГ-ММ-ДД'.
export function dayKey(now) {
  const shifted = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes() - DAY_BOUNDARY);
  return localKey(shifted);
}

export function addDays(key, n) {
  const d = new Date(utcOf(key) + n * 86400000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

const daysBetween = (a, b) => Math.round((utcOf(b) - utcOf(a)) / 86400000);

// Минуты момента от полуночи логического дня key (могут быть > 1440 или < 0).
export function minutesOf(moment, key) {
  const d = moment instanceof Date ? moment : new Date(moment);
  return daysBetween(key, localKey(d)) * 1440 + d.getHours() * 60 + d.getMinutes();
}

// 0 = воскресенье.
export const weekday = (key) => new Date(utcOf(key)).getUTCDay();

// Ближайшее воскресенье; если сегодня воскресенье — следующее.
export const endOfWeek = (key) => addDays(key, 7 - weekday(key) || 7);

// Конец дня в минутах: сон раньше подъёма — это следующие сутки.
export const sleepMin = (s) => (s.sleepAt <= s.defaultWake ? s.sleepAt + 1440 : s.sleepAt);

// Проверка настроек сна: после полуночи — не позже границы дня.
export const sleepValid = (s) => s.sleepAt > s.defaultWake || s.sleepAt <= DAY_BOUNDARY;

export function fmt(min) {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

export function fmtDur(min) {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  if (!h) return `${m} мин`;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

export function parseHM(s) {
  const m = /^(\d{2}):(\d{2})$/.exec(s ?? '');
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return +m[1] * 60 + +m[2];
}

const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MON = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
export function fmtDate(key) {
  const [, m, d] = key.split('-').map(Number);
  return `${WD[weekday(key)]}, ${d} ${MON[m - 1]}`;
}
