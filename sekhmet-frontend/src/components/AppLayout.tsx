import { Link, useRouterState } from "@tanstack/react-router";
import {
  LayoutDashboard,
  Package,
  Sparkles,
  ClipboardList,
  MessageSquarePlus,
  AlertTriangle,
  MessagesSquare,
  Menu,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: "Tableau de bord", icon: LayoutDashboard },
  { to: "/catalogue", label: "Catalogue", icon: Package },
  { to: "/bienfaits", label: "Bienfaits", icon: Sparkles },
  { to: "/procedures", label: "Procédures", icon: ClipboardList },
  { to: "/message-accueil", label: "Message d'accueil", icon: MessageSquarePlus },
  { to: "/escalades", label: "Escalades", icon: AlertTriangle },
  { to: "/conversations", label: "Conversations", icon: MessagesSquare },
] as const;

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <nav className="flex flex-col gap-1 p-3">
      {NAV.map(({ to, label, icon: Icon }) => {
        const active = to === "/" ? pathname === "/" : pathname.startsWith(to);
        return (
          <Link
            key={to}
            to={to}
            onClick={onNavigate}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-sidebar-foreground/85 transition-colors",
              "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
              active && "bg-sidebar-accent text-sidebar-accent-foreground",
            )}
          >
            <Icon className={cn("size-5 shrink-0 text-sidebar-primary")} />
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function Brand() {
  return (
    <div className="border-b border-sidebar-border px-5 py-5">
      <p className="text-lg font-bold tracking-tight text-sidebar-foreground">Sekhmet Shop</p>
      <p className="text-xs text-sidebar-primary">Administration</p>
    </div>
  );
}

export function AppLayout({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="min-h-screen bg-background">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 flex-col bg-sidebar md:flex">
        <Brand />
        <div className="flex-1 overflow-y-auto">
          <NavLinks />
        </div>
      </aside>

      <header className="sticky top-0 z-30 flex items-center gap-3 bg-sidebar px-4 py-3 md:hidden">
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger
            aria-label="Ouvrir le menu"
            className="rounded-md p-1.5 text-sidebar-primary transition-colors hover:bg-sidebar-accent"
          >
            <Menu className="size-6" />
          </SheetTrigger>
          <SheetContent side="left" className="w-72 border-0 bg-sidebar p-0">
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <Brand />
            <NavLinks onNavigate={() => setOpen(false)} />
          </SheetContent>
        </Sheet>
        <span className="font-semibold text-sidebar-foreground">Sekhmet Shop</span>
      </header>

      <main className="md:pl-64">
        <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8 md:py-10">{children}</div>
      </main>
    </div>
  );
}

export function PageHeader({ title, description }: { title: string; description?: string | undefined }) {
  return (
    <div className="mb-6">
      <h1 className="text-2xl font-bold tracking-tight text-primary md:text-3xl">{title}</h1>
      {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
    </div>
  );
}
