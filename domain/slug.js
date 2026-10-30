'use strict';
// Readable part of public URLs: /ruta/501-penalara-por-la-laguna-grande. The id decides the page; the slug is
// only for people and search engines (a different slug redirects to the canonical one).

/** Lowercase, accent-free words joined by "-", at most `max` characters, cut at a word boundary. */
function slugify(text, max = 70) {
  const s = String(text || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/ñ/g, 'n')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const i = cut.lastIndexOf('-');
  return (i > max / 2 ? cut.slice(0, i) : cut).replace(/-+$/, '');
}

module.exports = { slugify };
