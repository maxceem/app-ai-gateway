import { useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
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
import { useConsoleSession } from "@/lib/console-session";
import { authErrorMessage } from "@/lib/auth-errors";
import { formatDateTime } from "@/lib/format";
import { ROLE_LABELS } from "@/lib/permissions";
import { useChangePassword } from "@/lib/queries";

const MIN_PASSWORD_LENGTH = 8;

export function ProfilePage() {
  const { session, organization, role } = useConsoleSession();
  const user = session.user;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Profile</h1>
        <p className="text-sm text-muted-foreground">Your operator account for this gateway.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Account</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <Row label="Name" value={user?.name || "—"} />
          <Row label="Email" value={user?.email ?? "—"} />
          <Row
            label="Organization"
            value={
              <span className="flex items-center gap-2">
                {organization?.name ?? "—"}
                <Badge variant="secondary">{ROLE_LABELS[role]}</Badge>
              </span>
            }
          />
          <Row label="Member since" value={formatDateTime(user?.createdAt ?? null)} />
        </CardContent>
      </Card>

      <ChangePasswordCard />
    </div>
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
function ChangePasswordCard() {
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
