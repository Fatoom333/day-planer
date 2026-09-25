import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const sw = readFileSync(new URL('sw.js', root), 'utf8');
const listed = new Set([...sw.matchAll(/^\s+'([^']+)',$/gm)].map((m) => m[1]));

test('sw.js кэширует все свои файлы, иначе офлайн сломается', () => {
  const need = ['index.html', 'style.css', 'manifest.webmanifest',
    ...readdirSync(new URL('src/', root)).map((f) => `src/${f}`),
    ...readdirSync(new URL('icons/', root)).map((f) => `icons/${f}`)];
  for (const f of need) assert.ok(listed.has(f), `нет в FILES: ${f}`);
});

test('manifest ссылается на существующие иконки, пути относительные', () => {
  const m = JSON.parse(readFileSync(new URL('manifest.webmanifest', root), 'utf8'));
  assert.equal(m.start_url, './');
  assert.equal(m.scope, './');
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
  for (const i of m.icons) {
    assert.ok(!i.src.startsWith('/'), i.src);
    assert.ok(listed.has(i.src), `иконка не в кэше: ${i.src}`);
  }
});
