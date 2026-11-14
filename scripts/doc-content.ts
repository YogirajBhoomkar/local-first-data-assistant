// All content here is invented. Used by gen-docs.ts to build PDF and PPTX fixtures.

export interface DocPage {
  title: string;
  paragraphs: string[];
}

const filler = [
  "Underwriters should record the rationale for every decision in the file at the time it is made.",
  "Where information is incomplete, the underwriter should request clarification before quoting.",
  "Exceptions to this guidance require written approval and are reviewed each quarter.",
  "Teams are expected to apply the same standard of care to renewals as to new business.",
  "Questions about this section can be raised with the underwriting governance group.",
];
const pick = (i: number, n: number) => Array.from({ length: n }, (_, k) => filler[(i + k) % filler.length]!);

export const GUIDELINES: DocPage[] = [
  { title: "1. Purpose", paragraphs: ["This document sets out the underwriting guidelines of the fictional Northwind Mutual group.", ...pick(1, 2)] },
  { title: "2. Scope", paragraphs: ["These guidelines apply to all lines of business written by the group in every region.", ...pick(2, 2)] },
  { title: "3. Authority levels", paragraphs: ["Underwriters may bind a limit of up to USD 5 million on their own authority.", "Any limit above USD 5 million requires referral to the Chief Underwriting Officer.", ...pick(3, 1)] },
  { title: "4. Property", paragraphs: ["The maximum single-risk limit for Property is USD 25 million without a special referral.", "Property risks in high hazard areas need a recent survey report.", ...pick(4, 1)] },
  { title: "5. Marine cargo", paragraphs: ["Marine cargo clauses require a valid survey for any vessel older than 20 years.", ...pick(5, 2)] },
  { title: "6. Cyber", paragraphs: ["Cyber policies require evidence of multi-factor authentication before binding.", "Ransomware sublimits must not exceed 50 percent of the policy limit.", ...pick(6, 1)] },
  { title: "7. Aviation", paragraphs: ["Aviation hull exposures are written only for operators with at least three years of audited safety records.", ...pick(7, 2)] },
  { title: "8. Energy", paragraphs: ["Onshore energy exposures are capped at 10 percent of the portfolio aggregate.", ...pick(8, 2)] },
  { title: "9. Flood", paragraphs: ["Properties in flood zone A carry a mandatory deductible of 5 percent of the insured value.", ...pick(9, 2)] },
  { title: "10. Referral process", paragraphs: ["Referrals must be answered within 3 business days of receipt.", "Urgent referrals may be escalated by phone and confirmed in writing.", ...pick(10, 1)] },
  { title: "11. Pricing", paragraphs: ["Technical price is set from the approved rating model; discounts above 15 percent need approval.", ...pick(11, 2)] },
  { title: "12. Reinsurance", paragraphs: ["Facultative reinsurance is required for any single risk above USD 15 million.", ...pick(12, 2)] },
  { title: "13. Claims notification", paragraphs: ["Insureds must notify claims within 30 days of discovering a loss.", ...pick(13, 2)] },
  { title: "14. Sanctions screening", paragraphs: ["All parties to a policy are screened against sanctions lists before binding.", ...pick(14, 2)] },
  { title: "15. Record keeping", paragraphs: ["Underwriting files are retained for 10 years after the policy expires.", ...pick(15, 2)] },
  { title: "16. Glossary", paragraphs: ["Bind: to commit the insurer to a policy. Referral: escalation of a decision to a more senior authority.", ...pick(16, 2)] },
  { title: "17. Appendix A", paragraphs: ["Appendix A lists the approved rating models by line of business.", ...pick(17, 2)] },
  { title: "18. Appendix B", paragraphs: ["Appendix B lists the survey providers approved for property and marine risks.", ...pick(18, 2)] },
  { title: "19. Appendix C", paragraphs: ["Appendix C contains the template referral form and its guidance notes.", ...pick(19, 2)] },
  { title: "20. Change log", paragraphs: ["Version 3 revised the Property limit and the cyber authentication requirement.", ...pick(20, 2)] },
];

export const QUARTERLY: DocPage[] = [
  { title: "Quarterly summary", paragraphs: ["Gross written premium for the quarter was USD 412 million, up 6 percent on the prior year.", ...pick(1, 1)] },
  { title: "Underwriting result", paragraphs: ["The combined ratio improved to 94.2 percent, helped by lower attritional losses.", ...pick(2, 1)] },
  { title: "Distribution", paragraphs: ["The largest broker by volume was BRK-014, contributing 9 percent of premium.", ...pick(3, 1)] },
  { title: "Claims", paragraphs: ["Large loss activity was concentrated in windstorm events in two regions.", ...pick(4, 1)] },
  { title: "Outlook", paragraphs: ["Management expects rate increases to moderate to about 3 percent next quarter.", ...pick(5, 1)] },
];

export const SCANNED_PAGES = 3;

export interface Slide {
  title: string;
  bullets: string[];
  table?: string[][];
  notes?: string;
}

export const PORTFOLIO_REVIEW: Slide[] = [
  { title: "Portfolio review", bullets: ["Annual review of the property and casualty portfolio"], notes: "Welcome the audience and state the agenda." },
  { title: "Premium by line", bullets: ["Property is the largest line at 38 percent of premium", "Casualty follows at 27 percent"], table: [["Line", "Share"], ["Property", "38%"], ["Casualty", "27%"], ["Marine", "15%"]], notes: "Property share is up two points year on year." },
  { title: "Loss ratios", bullets: ["Marine had the lowest loss ratio at 52 percent", "Casualty loss ratio was 71 percent"], notes: "Marine benefited from a benign claims year." },
  { title: "Renewals", bullets: ["Renewal retention was 86 percent", "Rate change on renewals averaged 4 percent"], notes: "Speaker note: renewal retention target for next year is 88 percent." },
  { title: "Regional mix", bullets: ["EMEA contributes 46 percent of premium", "APAC is the fastest growing region"], table: [["Region", "Share"], ["EMEA", "46%"], ["AMER", "31%"], ["APAC", "23%"]] },
  { title: "Catastrophe exposure", bullets: ["Peak windstorm exposure sits in the north west region", "Reinsurance cover was renewed at the same attachment point"], notes: "Mention the attachment point has not changed." },
  { title: "Capital", bullets: ["Solvency coverage stands at 182 percent", "No change to the dividend policy"], notes: "Solvency figure is as at quarter end." },
  { title: "Risks", bullets: ["Inflation in repair costs", "Cyber accumulation"], notes: "Cyber accumulation is monitored monthly." },
  { title: "Actions", bullets: ["Tighten referral thresholds for energy", "Expand the broker panel in APAC"], notes: "Owners to be confirmed by the end of the month." },
  { title: "Questions", bullets: ["Thank you"], notes: "Close the meeting." },
];

export const BROKER_STRATEGY: Slide[] = [
  { title: "Broker strategy", bullets: ["Priorities for the next planning period"], notes: "Set the scene for the broker panel discussion." },
  { title: "Panel overview", bullets: ["120 active brokers", "Top 10 brokers write 41 percent of premium"], table: [["Tier", "Brokers"], ["Strategic", "10"], ["Core", "40"], ["Opportunistic", "70"]], notes: "Tiers are reviewed annually." },
  { title: "Service levels", bullets: ["Quote turnaround target is 2 business days", "Current average is 3.1 business days"], notes: "Speaker note: the gap is mostly in complex casualty risks." },
  { title: "Incentives", bullets: ["Volume bonus replaced by a profitability bonus", "Bonus is capped at 1.5 percent of premium"] },
  { title: "Digital", bullets: ["Online quoting available for small property risks", "Target 30 percent of small risks quoted online"], notes: "Pilot starts in two regions." },
  { title: "Training", bullets: ["Quarterly product sessions for strategic brokers"], notes: "Sessions are recorded for later viewing." },
  { title: "Compliance", bullets: ["All brokers complete annual sanctions training"], notes: "Completion is tracked in the broker portal." },
  { title: "Risks", bullets: ["Concentration with a few large brokers", "Slow response on complex risks"], notes: "Concentration limit is 12 percent per broker." },
  { title: "Roadmap", bullets: ["Pilot the profitability bonus in APAC", "Review panel tiers in the third quarter"], notes: "Roadmap dates are indicative." },
  { title: "Summary", bullets: ["Focus on profitable growth and faster service"], notes: "Close with the three priorities." },
];
