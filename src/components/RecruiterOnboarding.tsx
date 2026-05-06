import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useRecruiterProfile } from "@/hooks/use-recruiter-profile";
import type { HiringFocus, Tone, RecruiterProfile } from "@/lib/supabase";

interface RecruiterOnboardingProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isSettings?: boolean;
}

const HIRING_FOCUS_OPTIONS: { value: HiringFocus; label: string }[] = [
  { value: "engineering", label: "Engineering" },
  { value: "product", label: "Product" },
  { value: "design", label: "Design" },
  { value: "data", label: "Data" },
  { value: "sales", label: "Sales" },
  { value: "marketing", label: "Marketing" },
  { value: "finance", label: "Finance" },
  { value: "legal", label: "Legal" },
  { value: "hr", label: "HR" },
  { value: "operations", label: "Operations" },
  { value: "executive", label: "Executive" },
  { value: "other", label: "Other" },
];

const TONE_OPTIONS: { value: Tone; label: string; description: string }[] = [
  { value: "professional", label: "Professional", description: "Polished and business-appropriate" },
  { value: "friendly", label: "Friendly", description: "Warm and approachable" },
  { value: "direct", label: "Direct", description: "Concise and to the point" },
  { value: "warm", label: "Warm", description: "Personal and encouraging" },
  { value: "formal", label: "Formal", description: "Traditional and structured" },
];

export function RecruiterOnboarding({ open, onOpenChange, isSettings = false }: RecruiterOnboardingProps) {
  const { profile, upsertProfile } = useRecruiterProfile();
  const [fullName, setFullName] = useState(profile?.full_name ?? "");
  const [companyName, setCompanyName] = useState(profile?.company_name ?? "");
  const [jobTitle, setJobTitle] = useState(profile?.job_title ?? "");
  const [hiringFocus, setHiringFocus] = useState<HiringFocus>(profile?.hiring_focus ?? "engineering");
  const [tone, setTone] = useState<Tone>(profile?.tone ?? "professional");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const values: RecruiterProfile = { full_name: fullName, company_name: companyName, job_title: jobTitle, hiring_focus: hiringFocus, tone };
    const { error } = await upsertProfile(values);
    if (error) {
      setError(error.message);
    } else {
      setSaved(true);
      setTimeout(() => {
        setSaved(false);
        onOpenChange(false);
      }, 1200);
    }
    setLoading(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isSettings ? "Recruiter settings" : "Set up your recruiter profile"}</DialogTitle>
          <DialogDescription>
            {isSettings
              ? "Update how your name and company appear in AI-generated outreach emails."
              : "Tell us a bit about yourself — this personalizes every AI draft we write for you."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="fullName">Your name</Label>
              <Input
                id="fullName"
                placeholder="Jane Smith"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="jobTitle">Job title</Label>
              <Input
                id="jobTitle"
                placeholder="Senior Recruiter"
                value={jobTitle}
                onChange={(e) => setJobTitle(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="companyName">Company</Label>
            <Input
              id="companyName"
              placeholder="Acme Corp"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label>Hiring focus</Label>
            <Select value={hiringFocus} onValueChange={(v) => setHiringFocus(v as HiringFocus)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HIRING_FOCUS_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Email tone</Label>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {TONE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setTone(opt.value)}
                  className={`rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                    tone === opt.value
                      ? "border-foreground bg-foreground text-background"
                      : "border-border bg-background text-foreground hover:bg-muted"
                  }`}
                >
                  <span className="font-medium">{opt.label}</span>
                  <span className="mt-0.5 block text-xs opacity-70">{opt.description}</span>
                </button>
              ))}
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex justify-end gap-3 pt-2">
            {isSettings && (
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
            )}
            <Button type="submit" disabled={loading || saved}>
              {saved ? "Saved!" : loading ? "Saving…" : isSettings ? "Save changes" : "Save and continue"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
