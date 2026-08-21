import { Link, useRouterState } from "@tanstack/react-router";
import {
  LayoutDashboard,
  Boxes,
  Sparkles,
  Workflow,
  Mail,
  TriangleAlert,
  MessageCircle,
  Bell,
  Search,
  MoreHorizontal,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import logoUrl from "/logo.png?url";

const NAV = [
  { to: "/", label: "Vue d'ensemble", icon: LayoutDashboard },
  { to: "/catalogue", label: "Catalogue", icon: Boxes },
  { to: "/escalades", label: "Escalades", icon: TriangleAlert },
  { to: "/conversations", label: "Conversations", icon: MessageCircle },
] as const;
const SUPPORT_NAV = [
  { to: "/bienfaits", label: "Bienfaits", icon: Sparkles },
  { to: "/procedures", label: "Procédures", icon: Workflow },
  { to: "/message-accueil", label: "Message d'accueil", icon: Mail },
] as const;

function NavLinks({ items, onNavigate }: { items: readonly { to: string; label: string; icon: typeof LayoutDashboard }[]; onNavigate?: () => void }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <nav className="nav-list">
      {items.map(({ to, label, icon: Icon }) => {
        const active = to === "/" ? pathname === "/" : pathname.startsWith(to);
        return (
          <Link
            key={to}
            to={to}
            onClick={onNavigate}
            className={cn("nav-item", active && "active")}
          >
            <Icon aria-hidden="true" />
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function Brand() {
  return (
    <div className="brand-lockup">
      <img src={logoUrl} alt="Sekhmet Shop" className="brand-logo" />
      <div>
        <p className="brand-name">Sekhmet Shop</p>
        <p className="brand-subtitle">Espace opérations</p>
      </div>
    </div>
  );
}

export function AppLayout({ children }: { children: ReactNode }) {
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const current = [...NAV, ...SUPPORT_NAV].find((item) =>
    item.to === "/" ? pathname === "/" : pathname.startsWith(item.to),
  )?.label ?? "Vue d'ensemble";
  const pageTone = pathname.startsWith("/catalogue")
    ? "catalogue"
    : pathname.startsWith("/escalades")
      ? "escalades"
      : pathname.startsWith("/conversations")
        ? "conversations"
        : pathname.startsWith("/bienfaits")
          ? "bienfaits"
          : pathname.startsWith("/procedures")
            ? "procedures"
            : pathname.startsWith("/message-accueil")
              ? "message-accueil"
              : "dashboard";

  return (
    <div className={cn("dashboard-shell", `page-tone-${pageTone}`)}>
      <aside className="sidebar">
        <Brand />
        <p className="nav-label">Pilotage</p>
        <NavLinks items={NAV} />
        <p className="nav-label resources-label">Ressources</p>
        <NavLinks items={SUPPORT_NAV} />
        <div className="sidebar-foot">
          <div className="team-chip"><span className="team-avatar">LM</span><span>Équipe Sekhmet</span></div>
          <p className="sidebar-meta">Espace interne · v1.0</p>
        </div>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <div className="topbar-left">
            <img src={logoUrl} alt="Sekhmet Shop" className="topbar-logo" />
            <div className="breadcrumb"><span>Sekhmet Shop</span><span>/</span><strong>{current}</strong></div>
          </div>
          <div className="topbar-right">
            <label className="search-control global-search"><Search /><input type="search" placeholder="Rechercher" aria-label="Rechercher" /></label>
            <span className="topbar-divider" />
            <div className="notification-control">
              <button className="icon-button notification-wrap" aria-label="Ouvrir les notifications" onClick={() => setNotificationOpen((value) => !value)}><Bell /><span className="notification-dot" /></button>
              {notificationOpen && <div className="notification-panel"><p className="eyebrow">Sekhmet Shop</p><h2>Notifications</h2><p>Votre espace opérations est à jour.</p></div>}
            </div>
          </div>
        </header>
        <main className="page-content">{children}</main>
      </div>
      <nav className="mobile-tab-bar">
        {NAV.map(({ to, label, icon: Icon }) => <Link key={to} to={to} className={cn("mobile-tab", (to === "/" ? pathname === "/" : pathname.startsWith(to)) && "active")}><Icon /><span>{to === "/" ? "Accueil" : label}</span></Link>)}
        <button
          type="button"
          className={cn("mobile-tab", (moreOpen || SUPPORT_NAV.some((item) => pathname.startsWith(item.to))) && "active")}
          onClick={() => setMoreOpen(true)}
        >
          <MoreHorizontal />
          <span>Plus</span>
        </button>
      </nav>
      <Drawer open={moreOpen} onOpenChange={setMoreOpen}>
        <DrawerContent className="more-sheet">
          <DrawerHeader className="text-left">
            <DrawerTitle className="more-sheet-title">Ressources</DrawerTitle>
            <p className="more-sheet-sub">Textes et guides utilisés par l'agent</p>
          </DrawerHeader>
          <nav className="more-sheet-nav">
            {SUPPORT_NAV.map(({ to, label, icon: Icon }) => (
              <Link
                key={to}
                to={to}
                onClick={() => setMoreOpen(false)}
                className={cn("more-sheet-item", pathname.startsWith(to) && "active")}
              >
                <span className="more-sheet-icon"><Icon /></span>
                <span className="more-sheet-label">{label}</span>
              </Link>
            ))}
          </nav>
        </DrawerContent>
      </Drawer>
    </div>
  );
}

export function PageHeader({ title, description }: { title: string; description?: string | undefined }) {
  return (
    <div className="page-heading">
      <div><p className="eyebrow">{title === "Tableau de bord" ? "Mardi 14 mai 2024" : title}</p><h1 className="page-title">{title === "Tableau de bord" ? "Bonjour, Madame." : title}</h1>{description ? <p className="page-description">{description}</p> : null}</div>
    </div>
  );
}
