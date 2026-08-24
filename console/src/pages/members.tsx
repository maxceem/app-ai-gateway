import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DisabledReason, GuardedButton } from "@/components/guarded-button";
import { useConsoleSession } from "@/lib/console-session";
import { formatDateTime } from "@/lib/format";
import {
  ASSIGNABLE_ROLES,
  canChangeRole,
  canRemoveMember,
  ROLE_LABELS,
} from "@/lib/permissions";
import {
  useLeaveOrganization,
  useMembers,
  useRemoveMember,
  useUpdateMemberRole,
} from "@/lib/queries";
import type { OrganizationMember, OrganizationRole } from "@/lib/types";

export function MembersPage() {
  const { organization, role: actorRole, session, canManage } = useConsoleSession();
  // Listing members requires owner/admin on the server; do not even ask as a member.
  const list = useMembers(canManage);
  const navigate = useNavigate();
  const updateRole = useUpdateMemberRole();
  const removeMember = useRemoveMember();
  const leaveOrganization = useLeaveOrganization();
  const [pendingRemoval, setPendingRemoval] = useState<OrganizationMember | null>(null);
  // Per-row, not per-mutation: two concurrent role changes share one mutation
  // object, so its `variables` only ever describe the most recent call.
  const [rolesInFlight, setRolesInFlight] = useState<ReadonlySet<string>>(new Set());

  const members = list.data?.members ?? [];
  const ownerCount = members.filter((member) => member.role === "owner").length;

  const changeRole = async (member: OrganizationMember, nextRole: OrganizationRole) => {
    setRolesInFlight((current) => new Set(current).add(member.id));
    try {
      await updateRole.mutateAsync({ userId: member.id, role: nextRole });
      toast.success(`${member.email} is now ${ROLE_LABELS[nextRole].toLowerCase()}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not change the role");
    } finally {
      setRolesInFlight((current) => {
        const next = new Set(current);
        next.delete(member.id);
        return next;
      });
    }
  };

  const leavingSelf = pendingRemoval?.id === session.user?.id;

  const remove = async () => {
    if (!pendingRemoval) return;
    try {
      if (leavingSelf) {
        // Leaving rescopes the session to another organization, or to a freshly
        // provisioned one, so the whole cache goes rather than just the list.
        await leaveOrganization.mutateAsync(pendingRemoval.id);
        toast.success(`You left ${organization?.name ?? "the organization"}`);
        setPendingRemoval(null);
        await navigate("/apps", { replace: true });
        return;
      }
      await removeMember.mutateAsync(pendingRemoval.id);
      toast.success(`${pendingRemoval.email} removed`);
      setPendingRemoval(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove the member");
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Members</h1>
        <p className="text-sm text-muted-foreground">
          People with access to{" "}
          <span className="font-medium text-foreground">{organization?.name ?? "this organization"}</span>.
        </p>
      </div>

      {!canManage ? (
        <Alert>
          <AlertTitle>Read-only access</AlertTitle>
          <AlertDescription>
            Only owners and admins can view and manage the member list. Ask one of them for access.
          </AlertDescription>
        </Alert>
      ) : null}

      {list.isError ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Could not load members</AlertTitle>
          <AlertDescription>
            {list.error instanceof Error ? list.error.message : "Unknown error"}
          </AlertDescription>
        </Alert>
      ) : null}

      {canManage ? (
        <>
          <Card className="overflow-hidden py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Member</TableHead>
                  <TableHead>Joined</TableHead>
                  <TableHead className="w-40">Role</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.isPending ? (
                  [0, 1, 2].map((row) => (
                    <TableRow key={row}>
                      <TableCell colSpan={4}>
                        <Skeleton className="h-5 w-full" />
                      </TableCell>
                    </TableRow>
                  ))
                ) : members.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={4}
                      className="py-10 text-center text-sm text-muted-foreground"
                    >
                      No members yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  members.map((member) => {
                    const isSelf = member.id === session.user?.id;
                    const removal = canRemoveMember({
                      actorRole,
                      targetRole: member.role,
                      ownerCount,
                      isSelf,
                    });

                    return (
                      <TableRow key={member.id}>
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="font-medium">
                              {member.name || member.email}
                              {isSelf ? (
                                <Badge variant="secondary" className="ml-2">
                                  You
                                </Badge>
                              ) : null}
                            </span>
                            {member.name ? (
                              <span className="text-xs text-muted-foreground">{member.email}</span>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell className="tabular text-muted-foreground">
                          {formatDateTime(member.joinedAt)}
                        </TableCell>
                        <TableCell>
                          <RolePicker
                            member={member}
                            actorRole={actorRole}
                            ownerCount={ownerCount}
                            pending={rolesInFlight.has(member.id)}
                            onChange={(next) => void changeRole(member, next)}
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          <GuardedButton
                            variant="outline"
                            size="sm"
                            reason={removal.allowed ? undefined : removal.reason}
                            onClick={() => setPendingRemoval(member)}
                          >
                            {isSelf ? "Leave" : "Remove"}
                          </GuardedButton>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </Card>

          <p className="text-xs text-muted-foreground">
            New members join by creating an account and being added by an owner or admin. This
            gateway does not send email invitations.
          </p>
        </>
      ) : null}

      <ConfirmDialog
        open={pendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemoval(null);
        }}
        title={leavingSelf ? "Leave organization" : "Remove member"}
        description={
          leavingSelf ? (
            <p>
              You will lose access to{" "}
              <span className="font-medium text-foreground">{organization?.name}</span> and
              everything in it. Another owner or admin would have to add you back.
            </p>
          ) : (
            <p>
              <span className="font-medium text-foreground">{pendingRemoval?.email}</span> will lose
              access to this organization and everything in it.
            </p>
          )
        }
        confirmLabel={leavingSelf ? "Leave organization" : "Remove member"}
        destructive
        pending={removeMember.isPending || leaveOrganization.isPending}
        onConfirm={() => void remove()}
      />
    </div>
  );
}

/**
 * Roles the actor is actually allowed to assign stay selectable; the rest are
 * disabled in place so the hierarchy is visible rather than hidden.
 */
function RolePicker({
  member,
  actorRole,
  ownerCount,
  pending,
  onChange,
}: {
  member: OrganizationMember;
  actorRole: OrganizationRole;
  ownerCount: number;
  pending: boolean;
  onChange: (role: OrganizationRole) => void;
}) {
  const options = ASSIGNABLE_ROLES.map((role) => ({
    role,
    check: canChangeRole({ actorRole, currentRole: member.role, nextRole: role, ownerCount }),
  }));

  // Nothing can be changed at all: explain once on the trigger.
  const anyAllowed = options.some((option) => option.check.allowed);
  const trigger = (
    <SelectTrigger className="w-36" disabled={!anyAllowed || pending}>
      <SelectValue />
    </SelectTrigger>
  );

  return (
    <Select value={member.role} onValueChange={(value) => onChange(value as OrganizationRole)}>
      {anyAllowed ? (
        trigger
      ) : (
        <DisabledReason
          reason={
            options.find((option) => option.role !== member.role)?.check.reason
            ?? "This role cannot be changed."
          }
        >
          {trigger}
        </DisabledReason>
      )}
      <SelectContent>
        {options.map((option) => (
          <SelectItem
            key={option.role}
            value={option.role}
            disabled={option.role !== member.role && !option.check.allowed}
          >
            {ROLE_LABELS[option.role]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
