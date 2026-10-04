import type { Identifiers, MatterStage, SubjectType } from "./types";

export interface Preset {
  id: string;
  /** Text on the chip. */
  label: string;
  name: string;
  subject_type: SubjectType;
  identifiers: Identifiers;
  /** Shown on the chip so the audience knows what to expect before the check runs. */
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
  // Businesses
  {
    id: "paxful",
    label: "Paxful",
    name: "Paxful",
    subject_type: "organization",
    identifiers: { ...none, country: "United States", employer_or_role: "Paxful peer-to-peer crypto marketplace" },
    expected_outcome: "adverse",
    record: "FinCEN civil money penalty of $3.5 million for Bank Secrecy Act violations, December 2025",
    expected: { actions: ["escalate_to_edd"], stages: ["settled", "convicted"] },
    expected_source: "https://www.fincen.gov/news/news-releases/fincen-assesses-35-million-penalty-against-paxful-facilitating-suspicious",
    expected_source_fragments: ["fincen-assesses-35-million-penalty-against-paxful", "PaxfulConsentOrder"],
    verified_on: "2026-10-03",
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
  // Individuals: all from official releases, convicted or sentenced, none a public figure.
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
    id: "ashley-arandez",
    label: "Ashley Arandez",
    name: "Ashley Arandez",
    subject_type: "individual",
    identifiers: { ...none, country: "Australia", employer_or_role: "former financial services director, Hoppers Crossing, Victoria" },
    expected_outcome: "adverse",
    record: "Pleaded guilty to dishonest conduct, unlicensed conduct and dealing with proceeds of crime, August 2025; sentenced 8 May 2026 to 5 years 6 months (ASIC, County Court of Victoria)",
    expected: { actions: ["escalate_to_edd", "refer_for_sar_consideration"], stages: ["convicted"] },
    expected_source: "https://asic.gov.au/about-asic/news-centre/find-a-media-release/2026-releases/26-096mr-former-financial-services-director-ashley-arandez-sentenced-to-more-than-5-years-imprisonment",
    expected_source_fragments: ["26-096mr", "25-153mr", "23-153mr"],
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
    id: "maximilien-de-hoop-cartier",
    label: "Maximilien De Hoop Cartier",
    name: "Maximilien De Hoop Cartier",
    subject_type: "individual",
    identifiers: { ...none, country: "France", dob_or_age: "58" },
    expected_outcome: "adverse",
    record: "Sentenced 28 April 2026 to eight years for laundering hundreds of millions of dollars through shell companies (S.D. New York)",
    expected: { actions: ["escalate_to_edd", "refer_for_sar_consideration"], stages: ["convicted"] },
    expected_source: "https://www.justice.gov/usao-sdny/pr/french-national-sentenced-eight-years-prison-laundering-hundreds-millions-dollars",
    expected_source_fragments: ["french-national-sentenced-eight-years"],
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
];

export function presetById(id: string | undefined): Preset | undefined {
  return id ? PRESETS.find((p) => p.id === id) : undefined;
}
