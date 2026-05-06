import { createClient } from "@supabase/supabase-js";

declare const __SUPABASE_ANON_KEY__: string;

const SUPABASE_URL = "https://szxjcitbjcpkhxtjztay.supabase.co";

export const supabase = createClient(SUPABASE_URL, __SUPABASE_ANON_KEY__);

export type HiringFocus =
  | "engineering" | "product" | "design" | "data"
  | "sales" | "marketing" | "finance" | "legal"
  | "hr" | "operations" | "executive" | "other";

export type Tone = "professional" | "friendly" | "direct" | "warm" | "formal";

export interface RecruiterProfile {
  id?: string;
  user_id?: string;
  full_name: string;
  company_name: string;
  job_title: string;
  hiring_focus: HiringFocus;
  tone: Tone;
}
