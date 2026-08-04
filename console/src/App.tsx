import { Navigate, Route, Routes } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Toaster } from "@/components/ui/sonner";
import { AppShell } from "@/components/app-shell";
import { AppDetailPage } from "@/pages/app-detail";
import { AppsPage } from "@/pages/apps";
import { LoginPage } from "@/pages/login";
import { useSession } from "@/lib/queries";

export default function App() {
  const session = useSession();

  if (session.isPending) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (session.isError || !session.data?.authenticated) {
    return (
      <>
        <LoginPage />
        <Toaster position="top-center" />
      </>
    );
  }

  return (
    <>
      <AppShell>
        <Routes>
          <Route path="/" element={<Navigate to="/apps" replace />} />
          <Route path="/apps" element={<AppsPage />} />
          <Route path="/apps/:appId" element={<Navigate to="overview" replace />} />
          <Route path="/apps/:appId/:tab" element={<AppDetailPage />} />
          <Route path="*" element={<Navigate to="/apps" replace />} />
        </Routes>
      </AppShell>
      <Toaster position="top-center" />
    </>
  );
}
