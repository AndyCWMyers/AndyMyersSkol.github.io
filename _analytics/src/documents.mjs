// Match the public paper titles. Homepage and CV are always pinned by the dashboard.
const papers = [
  { name: "/", title: "Homepage" },
  { name: "/andrew_c_w_myers_CV.pdf", title: "CV" },
  { name: "/myers_silfa_fouirnaies_hall_fin_inc_adv.pdf", title: "Do Incumbents Still Enjoy a Financial Advantage? How Individuals Ceased to Advantage Incumbents While Corporate America Continues to Favor Them" },
  { name: "/myers_extremist_nominee_fundraising.pdf", title: "Do Donors Punish Extremist Primary Nominees? Evidence from Congress and American State Legislatures" },
  { name: "/myers_stateleg_press.pdf", title: "Press Coverage and Accountability in State Legislatures" },
  { name: "/handan-nader_myers_hall_polarization.pdf", title: "Polarization and State Legislative Elections" },
  { name: "/wu_et_al_fraud.pdf", title: "Are Dead People Voting By Mail? Evidence From Washington State Administrative Records" },
  { name: "/yoder_et_al_2021_turnout.pdf", title: "How Did Absentee Voting Impact the 2020 U.S. Election?" },
  { name: "/bethlendy_chen_myers_earmark_RD.pdf", title: "Partisan Favoritism in Public Spending: Evidence from Congressional Earmarks" },
  { name: "/myers_et_al_stateleg_primary_elec_data.pdf", title: "State Legislative Primary Election Returns Database, 1990–2026" },
  { name: "/asher_et_al_LLM_sycophancy.pdf", title: "Do Claude Code and Codex P-Hack? Sycophancy and Statistical Analysis in Large Language Models" },
  { name: "/myers_redistricting.pdf", title: "How Do Legislators Adapt to New Electorates? Evidence from Redistricting in Congress and American State Legislatures" },
];

const appendixParents = new Set([
  "/myers_silfa_fouirnaies_hall_fin_inc_adv.pdf", "/myers_extremist_nominee_fundraising.pdf",
  "/myers_stateleg_press.pdf", "/handan-nader_myers_hall_polarization.pdf",
  "/wu_et_al_fraud.pdf", "/yoder_et_al_2021_turnout.pdf",
]);

export const viewerDocuments = [...papers,
  ...papers.filter(paper => appendixParents.has(paper.name)).map(paper => ({
    name: paper.name.replace(/\.pdf$/, "_appendix.pdf"), title: paper.title + " - Appendix",
  })),
  { name: "/myers_congruence.pdf", title: "myers_congruence.pdf" },
  { name: "/myers_term_limits.pdf", title: "myers_term_limits.pdf" },
];

export default papers;
