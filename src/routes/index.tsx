import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getExtensionZipBase64 } from "@/functions/extension-zip.functions";
import { AuthModal } from "@/components/AuthModal";
import { RecruiterOnboarding } from "@/components/RecruiterOnboarding";
import { ClientOnly } from "@/components/ClientOnly";
import { useAuth } from "@/hooks/use-auth";
import { useRecruiterProfile } from "@/hooks/use-recruiter-profile";

export const Route = createFileRoute("/")({
  component: Index,
  head: () => ({
    meta: [
      { title: "SourcedOut — AI outreach for recruiters" },
      {
        name: "description",
        content: "Download the latest SourcedOut Chrome extension. AI-powered outreach for recruiters.",
      },
    ],
  }),
});

const EXTENSION_ID = "oekidhmjmaknllpbdagiffepogjgkjdj";

function AuthHeader() {
  const { user, loading: authLoading, signOut } = useAuth();
  const { profile, loading: profileLoading } = useRecruiterProfile();
  const [authOpen, setAuthOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    if (user && !profileLoading && !profile) {
      setOnboardingOpen(true);
    }
  }, [user, profileLoading, profile]);

  return (
    <>
      <div className="flex items-center justify-between mb-8">
        <p className="text-sm font-medium uppercase tracking-widest text-muted-foreground">
          SourcedOut
        </p>
        <div className="flex items-center gap-3">
          {!authLoading && (
            user ? (
              <>
                <span className="text-sm text-muted-foreground hidden sm:inline">{user.email}</span>
                <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
                  Settings
                </Button>
                <Button variant="ghost" size="sm" onClick={signOut}>
                  Sign out
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={() => setAuthOpen(true)}>
                Sign in
              </Button>
            )
          )}
        </div>
      </div>

      {user && profile && (
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-border bg-muted/40 px-3 py-1 text-xs text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
          {profile.full_name} · {profile.company_name}
        </div>
      )}

      <AuthModal open={authOpen} onOpenChange={setAuthOpen} />
      <RecruiterOnboarding open={onboardingOpen} onOpenChange={setOnboardingOpen} />
      <RecruiterOnboarding open={settingsOpen} onOpenChange={setSettingsOpen} isSettings />
    </>
  );
}

function Index() {
  const [downloadStatus, setDownloadStatus] = useState<"idle" | "downloading" | "error">("idle");
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const handleDownload = async () => {
    setDownloadStatus("downloading");
    setDownloadError(null);
    try {
      const { base64 } = await getExtensionZipBase64();
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: "application/zip" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "sourcedout-extension.zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setDownloadStatus("idle");
    } catch (e) {
      setDownloadError(e instanceof Error ? e.message : "Unknown error");
      setDownloadStatus("error");
    }
  };

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-3xl px-6 py-16">
        <ClientOnly>
          <AuthHeader />
        </ClientOnly>

        <header className="mb-12">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            AI-powered outreach for recruiters
          </h1>
          <p className="mt-4 text-lg text-muted-foreground">
            Find, enrich, and reach out to candidates on LinkedIn — without leaving the page.
          </p>
        </header>

        <Card className="mb-8">
          <CardHeader>
            <CardTitle>Download the extension</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button
              onClick={handleDownload}
              disabled={downloadStatus === "downloading"}
              size="lg"
              className="w-full sm:w-auto"
            >
              {downloadStatus === "downloading" ? "Preparing…" : "Download latest (.zip)"}
            </Button>
            {downloadError && (
              <p className="text-sm text-destructive">Error: {downloadError}</p>
            )}
            <div className="rounded-md border border-border bg-muted/40 p-4 text-sm">
              <p className="font-medium">Extension ID (locked)</p>
              <code className="mt-1 block break-all font-mono text-xs text-muted-foreground">
                {EXTENSION_ID}
              </code>
            </div>
          </CardContent>
        </Card>

        <Card className="mb-8">
          <CardHeader>
            <CardTitle>First-time install</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="list-decimal space-y-2 pl-5 text-sm">
              <li>Click the download button above and unzip the file.</li>
              <li>
                Open <code className="font-mono">chrome://extensions</code> in Chrome (or any Chromium browser).
              </li>
              <li>Toggle <strong>Developer mode</strong> on (top-right corner).</li>
              <li>Click <strong>Load unpacked</strong> and select the unzipped folder.</li>
              <li>Pin the SourcedOut icon to your toolbar and sign in.</li>
            </ol>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Updating to a new version</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="list-decimal space-y-2 pl-5 text-sm">
              <li>Download the new .zip from the button above.</li>
              <li>Unzip and replace the contents of the same folder you loaded originally.</li>
              <li>
                Open <code className="font-mono">chrome://extensions</code> → find SourcedOut → click the <strong>reload</strong> icon.
              </li>
            </ol>
            <p className="mt-4 text-xs text-muted-foreground">
              The extension ID is locked, so your sign-in and Supabase config keep working across updates.
            </p>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
