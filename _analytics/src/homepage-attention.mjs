import documents from "./documents.mjs";

export const SECTIONS = ["Bio", "Publications", "Working Papers", "Works in Progress", "Datasets"];
// Stable IDs are also used by data-acw-item in index.html. Never reuse an ID.
export const HOMEPAGE_ITEMS = [
  [1, "/myers_silfa_fouirnaies_hall_fin_inc_adv.pdf", 1],
  [2, "/myers_extremist_nominee_fundraising.pdf", 1],
  [3, "/myers_stateleg_press.pdf", 1],
  [4, "/handan-nader_myers_hall_polarization.pdf", 1],
  [5, "/wu_et_al_fraud.pdf", 1],
  [6, "/yoder_et_al_2021_turnout.pdf", 1],
  [7, "/bethlendy_chen_myers_earmark_RD.pdf", 2],
  [16, "/myers_et_al_stateleg_primary_elec_data.pdf", 2],
  [8, "/asher_et_al_LLM_sycophancy.pdf", 2],
  [9, "/myers_redistricting.pdf", 2],
  [10, "Do Interest Group Endorsements Influence American Elections?", 3],
  [11, "From Dollars to Ideal Points: Adjusting Campaign Finance Scalings for Co-Participation Bias", 3],
  [12, "The Hidden Incumbency Advantage: How Officeholding Shapes Intra-Party Competition in American Legislative and Executive Elections", 3],
  [13, "How Much Turnover Is There in U.S. Voter Registration Lists?", 3],
  [14, "State Legislative Primary Election Returns Database, 1990–2026", 4],
  [15, "State Voter Registration Panel, 2010-2022", 4],
].map(([id, name, section]) => ({ id, title: documents.find(doc => doc.name === name)?.title || name, section: SECTIONS[section] }));

export function validAttention(value, milliseconds) {
  if (value === undefined) return true;
  if (!value || Object.keys(value).sort().join(",") !== "depth,items,scrolled,sections"
    || !Number.isInteger(value.depth) || value.depth < 0 || value.depth > 100
    || ![0, 1].includes(value.scrolled)
    || !Number.isInteger(value.sections) || value.sections < 0 || value.sections > 31
    || !Array.isArray(value.items) || value.items.length > HOMEPAGE_ITEMS.length) return false;
  const seen = new Set();
  for (const row of value.items) {
    if (!Array.isArray(row) || row.length !== 4 || !row.every(Number.isSafeInteger)) return false;
    const [id, visible, opens, abstract] = row;
    if (!HOMEPAGE_ITEMS.some(item => item.id === id) || seen.has(id) || visible < 0 || visible > milliseconds
      || opens < 0 || opens > 1000 || abstract < 0 || abstract > visible) return false;
    seen.add(id);
  }
  return true;
}

// Used inside the existing atomic checkpoint guard; a late save cannot erase detail.
export const ATTENTION_MONOTONIC = `(h.attention IS NULL OR (
  COALESCE(json_extract(j.value,'$.attention.depth'),-1) >= json_extract(h.attention,'$.depth')
  AND COALESCE(json_extract(j.value,'$.attention.scrolled'),-1) >= json_extract(h.attention,'$.scrolled')
  AND (json_extract(j.value,'$.attention.sections') & json_extract(h.attention,'$.sections')) = json_extract(h.attention,'$.sections')
  AND NOT EXISTS (SELECT 1 FROM json_each(h.attention,'$.items') old_item
    WHERE NOT EXISTS (SELECT 1 FROM json_each(j.value,'$.attention.items') new_item
      WHERE json_extract(new_item.value,'$[0]') = json_extract(old_item.value,'$[0]')
        AND json_extract(new_item.value,'$[1]') >= json_extract(old_item.value,'$[1]')
        AND json_extract(new_item.value,'$[2]') >= json_extract(old_item.value,'$[2]')
        AND json_extract(new_item.value,'$[3]') >= json_extract(old_item.value,'$[3]')))))`;

export function summarizeAttention(values) {
  const recorded = values.filter(Boolean);
  if (!recorded.length) return undefined;
  let sections = 0, scrollDepth = 0, scrolled = false;
  const items = new Map();
  for (const value of recorded) {
    sections |= value.sections;
    scrollDepth = Math.max(scrollDepth, value.depth);
    scrolled ||= value.scrolled === 1;
    for (const [id, milliseconds, opens, abstract] of value.items) {
      const row = items.get(id) || { ...HOMEPAGE_ITEMS.find(item => item.id === id), visibleSeconds: 0, abstractOpens: 0, abstractSeconds: 0 };
      row.visibleSeconds += milliseconds / 1000;
      row.abstractOpens += opens;
      row.abstractSeconds += abstract / 1000;
      items.set(id, row);
    }
  }
  return { scrollDepth, scrolled, sections: SECTIONS.filter((_, index) => sections & (1 << index)),
    items: [...items.values()].filter(row => row.visibleSeconds >= 2 || row.abstractOpens > 0).sort((a, b) => a.id - b.id) };
}
