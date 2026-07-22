export interface Referee {
  name:      string;
  job_title: string;
  company:   string;
  email:     string;
}

export type ReferencesMode = "details" | "on_request" | "none";

export interface ReferencesData {
  mode?:                 ReferencesMode;
  /** Legacy field — mapped to mode on load */
  available_on_request?: boolean;
  referees?:             Referee[];
}
