// Ratings, flags and keywords for library photos. A photo carries { rating (0-5), flag ('pick' | 'reject' | null), keywords [text] }; they are kept in
// library.json and written to an XMP sidecar next to the photo (IMG_0001.xmp), which other programs (Lightroom, Bridge, digiKam and the like) read.

export const MAX_KEYWORDS = 50;
export const FLAGS = ['pick', 'reject'];

export const stars = (n) => '★'.repeat(Math.max(0, Math.min(5, n | 0)));

// Keywords from what a person typed: split at commas, semicolons and new lines, trimmed, without repeats (case aside).
export function parseKeywords(text) {
  const out = [];
  const seen = new Set();
  for (const part of String(text || '').split(/[,;\n]+/)) {
    const word = part.trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!word || seen.has(word.toLowerCase())) continue;
    seen.add(word.toLowerCase());
    out.push(word);
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
}

// Marks in their one valid form.
export function normalizeMarks(m = {}) {
  const rating = Math.max(0, Math.min(5, Math.round(+m.rating || 0)));
  return {
    rating,
    flag: FLAGS.includes(m.flag) ? m.flag : null,
    keywords: Array.isArray(m.keywords) ? parseKeywords(m.keywords.join(',')) : parseKeywords(m.keywords),
  };
}

export const marksOf = (photo) => normalizeMarks(photo || {});
export const hasMarks = (m) => !!(m.rating || m.flag || (m.keywords && m.keywords.length));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The XMP sidecar: xmp:Rating (-1 for a rejected photo, as Adobe's programs write it), xmpDM:pick (1 picked, -1 rejected) and dc:subject keywords.
export function toXmp(marks) {
  const m = normalizeMarks(marks);
  const rating = m.flag === 'reject' ? -1 : m.rating;
  const attrs = [`xmp:Rating="${rating}"`];
  if (m.flag) attrs.push(`xmpDM:pick="${m.flag === 'pick' ? 1 : -1}"`);
  const subject = m.keywords.length ? `\n   <dc:subject>\n    <rdf:Bag>\n${m.keywords.map((k) => `     <rdf:li>${esc(k)}</rdf:li>`).join('\n')}\n    </rdf:Bag>\n   </dc:subject>\n  ` : '';
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Illuminator">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
   xmlns:xmp="http://ns.adobe.com/xap/1.0/"
   xmlns:xmpDM="http://ns.adobe.com/xmp/1.0/DynamicMedia/"
   xmlns:dc="http://purl.org/dc/elements/1.1/"
   ${attrs.join('\n   ')}>${subject}</rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
`;
}

const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// Marks from an XMP sidecar (ours or another program's), or null when it has none.
export function parseXmp(text) {
  const t = String(text || '');
  const attr = (name) => {
    const m = t.match(new RegExp(`${name}="(-?\\d+)"`)) || t.match(new RegExp(`<${name}>\\s*(-?\\d+)\\s*</${name}>`));
    return m ? +m[1] : null;
  };
  const rating = attr('xmp:Rating');
  const pick = attr('xmpDM:pick');
  const subject = t.match(/<dc:subject>([\s\S]*?)<\/dc:subject>/);
  const keywords = subject ? [...subject[1].matchAll(/<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/g)].map((m) => unesc(m[1].trim())) : [];
  if (rating === null && pick === null && !keywords.length) return null;
  return normalizeMarks({ rating: rating > 0 ? rating : 0, flag: pick === 1 ? 'pick' : pick === -1 || rating === -1 ? 'reject' : null, keywords });
}

// Does the photo pass the library filter? { minRating (0-5), flag ('' any, 'pick', 'reject', 'notreject', 'none'), text (a keyword or part of the name) }
export function matchesFilter(photo, filter = {}) {
  const m = marksOf(photo);
  if (filter.minRating && m.rating < filter.minRating) return false;
  const f = filter.flag || '';
  if (f === 'pick' && m.flag !== 'pick') return false;
  if (f === 'reject' && m.flag !== 'reject') return false;
  if (f === 'notreject' && m.flag === 'reject') return false;
  if (f === 'none' && m.flag) return false;
  const text = String(filter.text || '').trim().toLowerCase();
  if (text) {
    const hay = [photo.name || '', ...m.keywords].map((s) => s.toLowerCase());
    if (!hay.some((s) => s.includes(text))) return false;
  }
  return true;
}

export const isFiltering = (filter) => !!(filter && (filter.minRating || filter.flag || (filter.text && filter.text.trim())));

// Every keyword in use, most used first.
export function allKeywords(photos) {
  const count = new Map();
  for (const p of photos) for (const k of marksOf(p).keywords) count.set(k, (count.get(k) || 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
}
