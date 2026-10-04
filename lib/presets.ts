import type { Identifiers, MatterStage, SubjectType } from "./types";

export interface Preset {
  id: string;
  /** Text on the chip. */
  label: string;
  name: string;
  subject_type: SubjectType;
  identifiers: Identifiers;
  /** Colours the chip: red for an adverse record on file, green for expected clear. */
  expected_outcome: "adverse" | "clean";
  /** One line for the presenter: what the official record says. Confirmed against expected_source on the date in verified_on. */
  record: string;
  expected: {
    actions: ("clear" | "escalate_to_edd" | "refer_for_sar_consideration" | "insufficient_information")[];
    /** Stages acceptable for the main true-match finding. Empty means any. */
    stages: MatterStage[];
  };
  /** Official source that states the record. Null for clean controls. */
  expected_source: string | null;
  /** The check passes the source test when any retrieved URL contains one of these fragments. */
  expected_source_fragments: string[];
  verified_on: string;
}

const none: Identifiers = { country: "", dob_or_age: "", employer_or_role: "", other: "" };

export const PRESETS: Preset[] = [
  // People. Adverse ones are from official releases (convicted or sentenced); none is a public figure.
  {
    id: "daniel-pugh",
    label: "Daniel Pugh",
    name: "Daniel Pugh",
    subject_type: "individual",
    identifiers: { ...none, country: "United Kingdom", employer_or_role: "investment scheme promoter, Devon", dob_or_age: "36" },
    expected_outcome: "adverse",
    record: "Convicted of conspiracy to defraud (£1.3m Ponzi scheme); sentenced 6 October 2025 to 7 years 6 months (FCA prosecution, Southwark Crown Court)",
    expected: { actions: ["escalate_to_edd", "refer_for_sar_consideration"], stages: ["convicted"] },
    expected_source: "https://www.fca.org.uk/news/press-releases/daniel-pugh-sentenced-for-ponzi-scheme",
    expected_source_fragments: ["daniel-pugh-sentenced", "daniel-edwin-robert-pugh", "confiscation-order-against-ponzi-scheme-fraudster"],
    verified_on: "2026-10-04",
  },
  {
    id: "xiao-rui",
    label: "Xiao Rui",
    name: "Xiao Rui",
    subject_type: "individual",
    identifiers: { ...none, country: "Hong Kong", employer_or_role: "owner of Augustine Holdings Limited, asset management", dob_or_age: "37" },
    expected_outcome: "adverse",
    record: "Convicted after trial of money laundering (about HK$64 million); sentenced 23 July 2026 to 6 years 9 months (ICAC, District Court)",
    expected: { actions: ["escalate_to_edd", "refer_for_sar_consideration"], stages: ["convicted"] },
    expected_source: "https://www.icac.org.hk/en/p/press/index_id_4987.html",
    expected_source_fragments: ["index_id_4987", "asset-management-firm-owner-gets-six-years"],
    verified_on: "2026-10-04",
  },
  {
    id: "jonathan-barach",
    label: "Jonathan Barach",
    name: "Jonathan Barach",
    subject_type: "individual",
    identifiers: { ...none, country: "United States", employer_or_role: "real estate agent, Philadelphia", dob_or_age: "47" },
    expected_outcome: "adverse",
    record: "Sentenced 8 April 2026 to 37 months for a fraudulent real estate loan scheme (E.D. Pennsylvania)",
    expected: { actions: ["escalate_to_edd", "refer_for_sar_consideration"], stages: ["convicted"] },
    expected_source: "https://www.justice.gov/usao-edpa/pr/center-city-real-estate-agent-sentenced-more-three-years-prison-lengthy-fraudulent",
    expected_source_fragments: ["center-city-real-estate-agent-sentenced", "center-city-real-estate-agent-pleads-guilty"],
    verified_on: "2026-10-03",
  },
  {
    id: "tamara-king",
    label: "Tamara King",
    name: "Tamara King",
    subject_type: "individual",
    identifiers: { ...none, country: "United States", employer_or_role: "former real estate broker, Bellevue and Kirkland, Washington", other: "Also known as Tamara Waln" },
    expected_outcome: "adverse",
    record: "Convicted at trial December 2025 of wire fraud, money laundering and tax fraud; sentenced May 2026 to 55 months (W.D. Washington)",
    expected: { actions: ["escalate_to_edd", "refer_for_sar_consideration"], stages: ["convicted"] },
    expected_source: "https://www.justice.gov/usao-wdwa/pr/former-seattle-area-real-estate-broker-sentenced-prison-fraud-investors-and-irs",
    expected_source_fragments: ["former-seattle-area-real-estate-broker-sentenced"],
    verified_on: "2026-10-03",
  },
  {
    id: "wade-foster",
    label: "Wade Foster",
    name: "Wade Foster",
    subject_type: "individual",
    identifiers: { ...none, country: "United States", employer_or_role: "co-founder and CEO of Zapier" },
    expected_outcome: "clean",
    record: "No adverse record expected",
    expected: { actions: ["clear"], stages: [] },
    expected_source: null,
    expected_source_fragments: [],
    verified_on: "2026-10-04",
  },
  // Companies
  {
    id: "paxful",
    label: "Paxful",
    name: "Paxful",
    subject_type: "organization",
    identifiers: { ...none, country: "United States", employer_or_role: "Paxful peer-to-peer crypto marketplace" },
    expected_outcome: "adverse",
    record: "Pleaded guilty (Travel Act and Bank Secrecy Act conspiracies), sentenced February 2026 to a $4 million penalty; FinCEN $3.5 million civil money penalty, December 2025",
    expected: { actions: ["escalate_to_edd"], stages: ["settled", "convicted"] },
    expected_source: "https://www.fincen.gov/news/news-releases/fincen-assesses-35-million-penalty-against-paxful-facilitating-suspicious",
    expected_source_fragments: ["fincen-assesses-35-million-penalty-against-paxful", "PaxfulConsentOrder", "virtual-asset-trading-platform"],
    verified_on: "2026-10-03",
  },
  {
    id: "draper-kramer-mortgage",
    label: "Draper & Kramer Mortgage",
    name: "Draper & Kramer Mortgage Corporation",
    subject_type: "organization",
    identifiers: { ...none, country: "United States", employer_or_role: "mortgage lender, Downers Grove, Illinois" },
    expected_outcome: "adverse",
    record: "CFPB consent order entered 24 January 2025: $1.5 million civil penalty and a five-year ban on residential mortgage lending (ECOA and CFPA violations)",
    expected: { actions: ["escalate_to_edd"], stages: ["settled"] },
    expected_source: "https://www.consumerfinance.gov/enforcement/actions/draper-kramer-mortgage-corporation/",
    expected_source_fragments: ["draper-kramer-mortgage-corporation", "draper-kramer"],
    verified_on: "2026-10-04",
  },
  {
    id: "wells-real-estate",
    label: "Wells Real Estate",
    name: "Wells Real Estate",
    subject_type: "organization",
    identifiers: { ...none, country: "United States", employer_or_role: "real estate investment company, South Florida", other: "Issued promissory notes to investors; principals Joseph and Bingham" },
    expected_outcome: "adverse",
    record: "Vehicle for a $50 million promissory-note fraud; principal Joseph pleaded guilty March 2026 and was sentenced in August 2026 to 20 years (S.D. Florida)",
    expected: { actions: ["escalate_to_edd", "refer_for_sar_consideration"], stages: ["convicted", "settled", "charged"] },
    expected_source: "https://www.justice.gov/usao-sdfl/pr/convicted-felon-sentenced-20-years-prison-50-million-real-estate-fraud-scheme",
    expected_source_fragments: ["50-million-real-estate-fraud-scheme"],
    verified_on: "2026-10-04",
  },
  {
    id: "zapier",
    label: "Zapier",
    name: "Zapier",
    subject_type: "organization",
    identifiers: { ...none, country: "United States", employer_or_role: "Zapier workflow automation software" },
    expected_outcome: "clean",
    record: "No adverse record expected",
    expected: { actions: ["clear"], stages: [] },
    expected_source: null,
    expected_source_fragments: [],
    verified_on: "2026-10-03",
  },
  {
    id: "khan-academy",
    label: "Khan Academy",
    name: "Khan Academy",
    subject_type: "organization",
    identifiers: { ...none, country: "United States" },
    expected_outcome: "clean",
    record: "No adverse record expected",
    expected: { actions: ["clear"], stages: [] },
    expected_source: null,
    expected_source_fragments: [],
    verified_on: "2026-10-01",
  },
];

export function presetById(id: string | undefined): Preset | undefined {
  return id ? PRESETS.find((p) => p.id === id) : undefined;
}
