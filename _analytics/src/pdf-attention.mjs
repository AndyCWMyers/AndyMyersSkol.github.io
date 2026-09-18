export function validPdfAttention(value, milliseconds = 3600000) {
  if (value === undefined) return true;
  if (!value || !["pages,scrolled,total", "pages,scrolled,seconds,total"].includes(Object.keys(value).sort().join(","))
    || !Number.isInteger(value.total) || value.total < 1 || value.total > 10000
    || ![0, 1].includes(value.scrolled) || !Array.isArray(value.pages)
    || value.pages.length !== Math.ceil(value.total / 32)
    || !value.pages.every(word => Number.isSafeInteger(word) && word >= 0 && word <= 4294967295)) return false;
  if (value.seconds !== undefined && (!Array.isArray(value.seconds) || value.seconds.length !== value.total
    || !value.seconds.every((seconds, i) => Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 3600
      && (!seconds || (value.pages[i >>> 5] & (1 << (i % 32)))))
    || value.seconds.reduce((sum, seconds) => sum + seconds, 0) * 1000 > milliseconds)) return false;
  return value.total % 32 === 0 || value.pages.at(-1) < 2 ** (value.total % 32);
}

export const PDF_ATTENTION_MONOTONIC = `(h.pdf_attention IS NULL OR (
  COALESCE(json_extract(j.value,'$.pdfAttention.total'),-1) = json_extract(h.pdf_attention,'$.total')
  AND COALESCE(json_extract(j.value,'$.pdfAttention.scrolled'),-1) >= json_extract(h.pdf_attention,'$.scrolled')
  AND NOT EXISTS (SELECT 1 FROM json_each(h.pdf_attention,'$.pages') old_word
    WHERE (COALESCE(json_extract(j.value,'$.pdfAttention.pages[' || old_word.key || ']'),0) & old_word.value) != old_word.value)
  AND (json_type(h.pdf_attention,'$.seconds') IS NULL OR (
    json_type(j.value,'$.pdfAttention.seconds') = 'array'
    AND NOT EXISTS (SELECT 1 FROM json_each(h.pdf_attention,'$.seconds') old_time
      WHERE old_time.value > 0 AND COALESCE(json_extract(j.value,'$.pdfAttention.seconds[' || old_time.key || ']'),-1) < old_time.value)))))`;

export function summarizePdfAttention(values) {
  const recorded = values.filter(Boolean);
  if (!recorded.length) return undefined;
  const totalPages = Math.max(...recorded.map(value => value.total));
  const words = Array(Math.ceil(totalPages / 32)).fill(0);
  for (const value of recorded) value.pages.forEach((word, i) => { words[i] = (words[i] | word) >>> 0; });
  const pages = [];
  for (let i = 0; i < totalPages; i++) if (words[i >>> 5] & (1 << (i % 32))) pages.push(i + 1);
  const timed = recorded.filter(value => Array.isArray(value.seconds));
  const seconds = Array(totalPages).fill(0);
  for (const value of timed) value.seconds.forEach((time, i) => { seconds[i] += time; });
  const measuredSeconds = seconds.reduce((sum, time) => sum + time, 0);
  const pageTimes = seconds.flatMap((visibleSeconds, i) => visibleSeconds > 0
    ? [{ page: i + 1, visibleSeconds, share: visibleSeconds / measuredSeconds }] : []);
  return { totalPages, pages, scrolled: recorded.some(value => value.scrolled === 1), furthestPage: pages.at(-1) || 0,
    ...(timed.length ? { pageTimes, measuredSeconds, timingPartial: timed.length !== recorded.length } : {}) };
}
