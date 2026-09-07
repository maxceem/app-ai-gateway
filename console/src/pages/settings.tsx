import { useState, type FormEvent } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/field";
import { useConsoleSession } from "@/lib/console-session";
import { authErrorMessage } from "@/lib/auth-errors";
import { formatDateTime } from "@/lib/format";
import { useChangePassword } from "@/lib/queries";
import { cn } from "@/lib/utils";

const MIN_PASSWORD_LENGTH = 8;

interface SettingsSection {
  slug: string;
  label: string;
  Component: () => React.ReactElement;
}

/**
 * Settings is one destination with several subjects, so the subjects live in a
 * second-level menu beside the panel rather than as separate sidebar entries.
 * The order here is the order the operator reads down the menu.
 */
const SECTIONS: SettingsSection[] = [
  { slug: "account", label: "Account", Component: AccountSection },
  { slug: "password", label: "Change password", Component: ChangePasswordSection },
];

export const DEFAULT_SETTINGS_SECTION = SECTIONS[0]!.slug;

export function SettingsPage() {
  const { section = DEFAULT_SETTINGS_SECTION } = useParams();
  const active = SECTIONS.find((entry) => entry.slug === section);

  // An unknown subject is a stale or hand-typed link, not an error worth a screen.
  if (!active) return <Navigate to={`/settings/${DEFAULT_SETTINGS_SECTION}`} replace />;

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" />

      <div className="flex flex-col gap-6 lg:flex-row">
        <nav aria-label="Settings sections" className="flex gap-1 overflow-x-auto lg:w-56 lg:shrink-0 lg:flex-col">
          {SECTIONS.map((entry) => {
            const current = entry.slug === active.slug;
            return (
              <Link
                key={entry.slug}
                to={`/settings/${entry.slug}`}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "flex h-9 shrink-0 items-center rounded-lg px-3 text-sm font-medium transition-colors",
                  "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  current
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground",
                )}
              >
                {entry.label}
              </Link>
            );
          })}
        </nav>

        <div className="min-w-0 flex-1">
          <active.Component />
        </div>
      </div>
    </div>
  );
}

function AccountSection() {
  const { session } = useConsoleSession();
  const user = session.user;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Account</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <Row label="Name" value={user?.name || "—"} />
        <Row label="Email" value={user?.email ?? "—"} />
        <Row label="Member since" value={formatDateTime(user?.createdAt ?? null)} />
      </CardContent>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3 last:border-0 last:pb-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

/**
 * Better Auth exposes `change-password` for password accounts. Google-only
 * accounts have no current password, so a failure there is reported rather
 * than the form being hidden — the console cannot tell the two apart from the
 * session alone.
 */
function ChangePasswordSection() {
  const changePassword = useChangePassword();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
  const ready =
    currentPassword.length > 0 && newPassword.length >= MIN_PASSWORD_LENGTH && !mismatch;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    try {
      await changePassword.mutateAsync({ currentPassword, newPassword });
      toast.success("Password changed. Other sessions were signed out.");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (error) {
      toast.error(authErrorMessage(error, "Could not change the password"));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Change password</CardTitle>
        <CardDescription>
          Changing your password signs out your other sessions.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={(event) => void submit(event)} className="max-w-sm space-y-4">
          <div className="space-y-2">
            <Label htmlFor="current-password">Current password</Label>
            <Input
              id="current-password"
              type="password"
              value={currentPassword}
              autoComplete="current-password"
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              type="password"
              value={newPassword}
              autoComplete="new-password"
              onChange={(event) => setNewPassword(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              At least {MIN_PASSWORD_LENGTH} characters.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm-password">Confirm new password</Label>
            <Input
              id="confirm-password"
              type="password"
              value={confirmPassword}
              autoComplete="new-password"
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
          </div>
          {mismatch ? <p className="text-sm text-destructive">Passwords do not match.</p> : null}
          <Button type="submit" disabled={!ready || changePassword.isPending}>
            {changePassword.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Change password
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
