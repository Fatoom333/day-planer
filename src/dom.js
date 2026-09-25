// Единственный способ строить DOM в приложении. Текст — только узлами (textContent),
// обработчики — только addEventListener. HTML-строки не разбираются нигде.

const PROPS = new Set(['value', 'checked', 'disabled', 'hidden', 'type', 'min', 'max', 'name', 'required']);

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k.startsWith('on') || k === 'style' || k === 'href' || k === 'src') throw new Error(`h(): атрибут ${k} запрещён`);
    else if (PROPS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
