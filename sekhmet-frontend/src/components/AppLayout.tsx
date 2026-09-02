import { Link, useRouterState } from "@tanstack/react-router";
import {
  LayoutDashboard,
  Boxes,
  Sparkles,
  Workflow,
  Mail,
  TriangleAlert,
  MessageCircle,
  Receipt,
  Bell,
  Search,
  MoreHorizontal,
  Wallet,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import logoUrl from "/logo.png?url";

const NAV = [
  { to: "/", label: "Vue d'ensemble", icon: LayoutDashboard },
  { to: "/catalogue", label: "Catalogue", icon: Boxes },
  { to: "/escalades", label: "Escalades", icon: TriangleAlert },
  { to: "/conversations", label: "Conversations", icon: MessageCircle },
  { to: "/factures", label: "Factures", icon: Receipt },
] as const;
// Barre de navigation mobile : Escalades + Conversations sont réunies dans
// un seul onglet "Chat". Les paniers sont également regroupés dans Chat afin
// de garder une navigation mobile limitée à 5 icônes maximum.
// (cf. NAV ci-dessus) — cette fusion ne concerne QUE le mobile.
type MobileNavItem = {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  matches?: readonly string[];
};
const MOBILE_NAV: readonly MobileNavItem[] = [
  { to: "/", label: "Accueil", icon: LayoutDashboard },
  { to: "/catalogue", label: "Catalogue", icon: Boxes },
  {
    to: "/chat",
    label: "Chat",
    icon: MessageCircle,
    matches: ["/chat", "/conversations", "/escalades"],
  },
  { to: "/factures", label: "Factures", icon: Receipt },
  { to: "/plus", label: "Plus", icon: MoreHorizontal },
];
const SUPPORT_NAV = [
  { to: "/bienfaits", label: "Bienfaits", icon: Sparkles },
  { to: "/procedures", label: "Procédures", icon: Workflow },
  { to: "/message-accueil", label: "Message d'accueil", icon: Mail },
  { to: "/paiement", label: "Compte de paiement", icon: Wallet },
] as const;

function NavLinks({
  items,
  onNavigate,
}: {
  items: readonly { to: string; label: string; icon: typeof LayoutDashboard }[];
  onNavigate?: () => void;
}) {
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
      <span className="brand-logo-surface"><img src={logoUrl} alt="Sekhmet Shop" className="brand-logo" /></span>
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
  const current = pathname.startsWith("/chat")
    ? "Chat"
    : ([...NAV, ...SUPPORT_NAV].find((item) =>
        item.to === "/" ? pathname === "/" : pathname.startsWith(item.to),
      )?.label ?? "Vue d'ensemble");
  const pageTone = pathname.startsWith("/catalogue")
    ? "catalogue"
    : pathname.startsWith("/escalades")
      ? "escalades"
      : pathname.startsWith("/conversations") || pathname.startsWith("/chat")
        ? "conversations"
        : pathname.startsWith("/factures")
          ? "factures"
          : pathname.startsWith("/paniers")
            ? "paniers"
            : pathname.startsWith("/bienfaits")
            ? "bienfaits"
            : pathname.startsWith("/procedures")
              ? "procedures"
              : pathname.startsWith("/message-accueil")
                ? "message-accueil"
                : pathname.startsWith("/paiement")
                  ? "paiement"
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
          <div className="team-chip">
            <span className="team-avatar">LM</span>
            <span>Équipe Sekhmet</span>
          </div>
          <p className="sidebar-meta">Espace interne · v1.0</p>
        </div>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <div className="topbar-left">
            <img src={logoUrl} alt="Sekhmet Shop" className="topbar-logo" />
            <div className="breadcrumb">
              <span>Sekhmet Shop</span>
              <span>/</span>
              <strong>{current}</strong>
            </div>
          </div>
          <div className="topbar-right">
            <label className="search-control global-search">
              <Search />
              <input type="search" placeholder="Rechercher" aria-label="Rechercher" />
            </label>
            <span className="topbar-divider" />
            <div className="notification-control">
              <button
                className="icon-button notification-wrap"
                aria-label="Ouvrir les notifications"
                onClick={() => setNotificationOpen((value) => !value)}
              >
                <Bell />
                <span className="notification-dot" />
              </button>
              {notificationOpen && (
                <div className="notification-panel">
                  <p className="eyebrow">Sekhmet Shop</p>
                  <h2>Notifications</h2>
                  <p>Votre espace opérations est à jour.</p>
                </div>
              )}
            </div>
          </div>
        </header>
        <main className="page-content">{children}</main>
      </div>
      <nav className="mobile-tab-bar">
        {MOBILE_NAV.map(({ to, label, icon: Icon, matches }) => {
          if (to === "/plus") {
            return (
              <button
                key={to}
                type="button"
                className={cn(
                  "mobile-tab",
                  (moreOpen || SUPPORT_NAV.some((item) => pathname.startsWith(item.to))) && "active",
                )}
                onClick={() => setMoreOpen(true)}
              >
                <Icon />
                <span>{label}</span>
              </button>
            );
          }
          const matchPaths = matches ?? [to];
          const active = to === "/" ? pathname === "/" : matchPaths.some((p) => pathname.startsWith(p));
          return (
            <Link key={to} to={to} className={cn("mobile-tab", active && "active")}>
              <Icon />
              <span>{label}</span>
            </Link>
          );
        })}
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
                <span className="more-sheet-icon">
                  <Icon />
                </span>
                <span className="more-sheet-label">{label}</span>
              </Link>
            ))}
          </nav>
        </DrawerContent>
      </Drawer>
    </div>
  );
}

export function PageHeader({
  title,
  description,
}: {
  title: string;
  description?: string | undefined;
}) {
  return (
    <div className="page-heading">
      <div>
        <p className="eyebrow">{title === "Tableau de bord" ? "Mardi 14 mai 2024" : title}</p>
        <h1 className="page-title">{title === "Tableau de bord" ? "Bonjour, Madame." : title}</h1>
        {description ? <p className="page-description">{description}</p> : null}
      </div>
    </div>
  );
}
