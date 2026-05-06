import { useEffect, useState, useCallback } from "react";
import { supabase, type RecruiterProfile } from "@/lib/supabase";
import { useAuth } from "@/hooks/use-auth";

export function useRecruiterProfile() {
  const { user } = useAuth();
  const [profile, setProfile] = useState<RecruiterProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchProfile = useCallback(async () => {
    if (!user) { setLoading(false); return; }
    const { data } = await supabase
      .from("recruiter_profiles")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();
    setProfile(data ?? null);
    setLoading(false);
  }, [user]);

  useEffect(() => { fetchProfile(); }, [fetchProfile]);

  const upsertProfile = async (values: RecruiterProfile) => {
    if (!user) return { error: new Error("Not authenticated") };
    const { error } = await supabase
      .from("recruiter_profiles")
      .upsert({ ...values, user_id: user.id }, { onConflict: "user_id" });
    if (!error) setProfile({ ...values, user_id: user.id });
    return { error };
  };

  return { profile, loading, upsertProfile, refetch: fetchProfile };
}
