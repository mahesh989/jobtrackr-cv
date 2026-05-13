// ============================================================
// JobTrackr — Supabase TypeScript types
// Generated manually from schema. Once the Supabase project is
// live, replace with: npx supabase gen types typescript --linked
// ============================================================

export type UserRole = "founder" | "beta" | "admin";
export type VisaFilterMode = "probability_sort" | "any" | "sponsored_only";
export type DedupStatus = "original" | "duplicate" | "repost";
export type RunStatus = "running" | "completed" | "failed";

export interface Database {
  public: {
    Tables: {
      users: {
        Row: {
          id: string;
          email: string;
          role: UserRole;
          invite_code_used: string | null;
          created_at: string;
        };
        Insert: {
          id: string;
          email: string;
          role?: UserRole;
          invite_code_used?: string | null;
          created_at?: string;
        };
        Update: {
          role?: UserRole;
          invite_code_used?: string | null;
        };
      };
      invite_codes: {
        Row: {
          code: string;
          created_by: string | null;
          used_by: string | null;
          used_at: string | null;
          is_active: boolean;
          created_at: string;
        };
        Insert: {
          code: string;
          created_by?: string | null;
          is_active?: boolean;
        };
        Update: {
          used_by?: string | null;
          used_at?: string | null;
          is_active?: boolean;
        };
      };
      search_profiles: {
        Row: {
          id: string;
          user_id: string;
          name: string;
          keywords: string[];
          location: string;
          visa_filter_mode: VisaFilterMode;
          schedule_cron: string;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          name: string;
          keywords?: string[];
          location?: string;
          visa_filter_mode?: VisaFilterMode;
          schedule_cron?: string;
          is_active?: boolean;
        };
        Update: {
          name?: string;
          keywords?: string[];
          location?: string;
          visa_filter_mode?: VisaFilterMode;
          schedule_cron?: string;
          is_active?: boolean;
        };
      };
      jobs: {
        Row: {
          id: string;
          profile_id: string;
          url_hash: string;
          url: string;
          title: string;
          company: string;
          location: string;
          description: string;
          source: string;
          source_tier: number;
          posted_at: string | null;
          expires_at: string | null;
          is_expired: boolean;
          is_dead_link: boolean;
          dedup_status: DedupStatus;
          duplicate_of: string | null;
          repost_of: string | null;
          ai_relevance_score: number | null;
          visa_likelihood: number | null;
          keywords_matched: string[];
          seen_at: string | null;
          applied_at: string | null;
          dismissed_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          profile_id: string;
          url_hash: string;
          url: string;
          title: string;
          company?: string;
          location?: string;
          description?: string;
          source: string;
          source_tier?: number;
          posted_at?: string | null;
          expires_at?: string | null;
          is_expired?: boolean;
          is_dead_link?: boolean;
          dedup_status?: DedupStatus;
          duplicate_of?: string | null;
          repost_of?: string | null;
          ai_relevance_score?: number | null;
          visa_likelihood?: number | null;
          keywords_matched?: string[];
        };
        Update: {
          is_expired?: boolean;
          is_dead_link?: boolean;
          ai_relevance_score?: number | null;
          visa_likelihood?: number | null;
          seen_at?: string | null;
          applied_at?: string | null;
          dismissed_at?: string | null;
        };
      };
      run_logs: {
        Row: {
          id: string;
          profile_id: string;
          started_at: string;
          finished_at: string | null;
          status: RunStatus;
          jobs_fetched: number;
          jobs_after_dedup: number;
          jobs_saved: number;
          error_message: string | null;
          sources_run: string[];
          created_at: string;
        };
        Insert: {
          id?: string;
          profile_id: string;
          started_at?: string;
          status?: RunStatus;
          sources_run?: string[];
        };
        Update: {
          finished_at?: string | null;
          status?: RunStatus;
          jobs_fetched?: number;
          jobs_after_dedup?: number;
          jobs_saved?: number;
          error_message?: string | null;
          sources_run?: string[];
        };
      };
      ai_cache: {
        Row: {
          cache_key: string;
          profile_id: string | null;
          result_json: {
            relevance_score: number;
            visa_likelihood: number;
            visa_signals: string[];
          };
          created_at: string;
          expires_at: string;
        };
        Insert: {
          cache_key: string;
          profile_id?: string | null;
          result_json: {
            relevance_score: number;
            visa_likelihood: number;
            visa_signals: string[];
          };
          expires_at?: string;
        };
        Update: never;
      };
    };
  };
}
