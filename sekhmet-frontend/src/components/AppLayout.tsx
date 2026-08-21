import { Link, useRouterState } from "@tanstack/react-router";
import {
  LayoutDashboard,
  Boxes,
  Sparkles,
  Workflow,
  Mail,
  TriangleAlert,
  MessageCircle,
  Menu,
  Bell,
  Search,
  MoreHorizontal,
  X,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: "Vue d’ensemble", icon: LayoutDashboard },
  { to: "/catalogue", label: "Catalogue", icon: Boxes },
  { to: "/escalades", label: "Escalades", icon: TriangleAlert },
  { to: "/conversations", label: "Conversations", icon: MessageCircle },
] as const;
const SUPPORT_NAV = [
  { to: "/bienfaits", label: "Bienfaits", icon: Sparkles },
  { to: "/procedures", label: "Procédures", icon: Workflow },
  { to: "/message-accueil", label: "Message d’accueil", icon: Mail },
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
      <div className="brand-mark" aria-hidden="true">S</div>
      <div>
        <p className="brand-name">Sekhmet Shop</p>
        <p className="brand-subtitle">Espace opérations</p>
      </div>
    </div>
  );
}

export function AppLayout({ children }: { children: ReactNode }) {
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [sheetHeight, setSheetHeight] = useState(330);
  const [dragStart, setDragStart] = useState<{ y: number; height: number } | null>(null);
  const [notificationOpen, setNotificationOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const current = [...NAV, ...SUPPORT_NAV].find((item) =>
    item.to === "/" ? pathname === "/" : pathname.startsWith(item.to),
  )?.label ?? "Vue d’ensemble";

  return (
    <div className="dashboard-shell">
      {resourcesOpen && <button className="mobile-backdrop" aria-label="Fermer les ressources" onClick={() => setResourcesOpen(false)} />}
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
        {NAV.map(({ to, label, icon: Icon }) => <Link key={to} to={to} onClick={() => setResourcesOpen(false)} className={cn("mobile-tab", (to === "/" ? pathname === "/" : pathname.startsWith(to)) && "active")}><Icon /><span>{to === "/" ? "Accueil" : label}</span></Link>)}
        <button className={cn("mobile-tab", SUPPORT_NAV.some((item) => pathname.startsWith(item.to)) && "active")} onClick={() => setResourcesOpen((value) => !value)}><MoreHorizontal /><span>Plus</span></button>
      </nav>
      <section className={cn("mobile-resource-sheet", resourcesOpen && "open")} style={{ height: sheetHeight }} aria-label="Ressources" aria-hidden={!resourcesOpen}>
        <button
          className="sheet-handle"
          aria-label="Ajuster la hauteur des ressources"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            setDragStart({ y: event.clientY, height: sheetHeight });
          }}
          onPointerMove={(event) => {
            if (dragStart) setSheetHeight(Math.max(220, Math.min(560, dragStart.height + dragStart.y - event.clientY)));
          }}
          onPointerUp={() => setDragStart(null)}
          onPointerCancel={() => setDragStart(null)}
        />
        <div className="sheet-header">
          <div><p className="eyebrow">Espace opérations</p><h2>Ressources</h2></div>
          <button className="icon-button" aria-label="Fermer les ressources" onClick={() => setResourcesOpen(false)}><X /></button>
        </div>
        <NavLinks items={SUPPORT_NAV} onNavigate={() => setResourcesOpen(false)} />
        <p className="sheet-footer">Contenus et procédures de votre boutique</p>
      </section>
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
