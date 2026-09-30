import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { Blocks, Funnel, GraduationCap, HandCoins, LayoutDashboard, LogOut, Mail, Menu, Settings, ShoppingBag, Users, X, ChevronsUpDown, Zap, type LucideIcon } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { useEdition } from '../lib/edition';
import { eeWeb } from '../lib/ee';
import { initials } from '../lib/format';
import { Avatar, cx } from './ui';

const NAV: { to: string; label: string; icon: LucideIcon; end?: boolean }[] = [
  { to: '/', label: 'Tableau de bord', icon: LayoutDashboard, end: true },
  { to: '/funnels', label: 'Tunnels', icon: Funnel },
  { to: '/emails', label: 'Emails', icon: Mail },
  { to: '/courses', label: 'Formations', icon: GraduationCap },
  { to: '/sales', label: 'Ventes', icon: ShoppingBag },
  { to: '/affiliation', label: 'Affiliation', icon: HandCoins },
  { to: '/contacts', label: 'Contacts', icon: Users },
  { to: '/automations', label: 'Automatisations', icon: Zap },
  { to: '/settings', label: 'Paramètres', icon: Settings },
];

/** Scalo mark: three stepped pills on the indigo tile (source: brand/logo/scalo-icon.svg). */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="shrink-0">
      <rect width="64" height="64" rx="16" fill="#5B4BFF" />
      <rect x="12" y="38.5" width="24" height="13" rx="6.5" fill="#BDB7FF" />
      <rect x="20" y="25.5" width="24" height="13" rx="6.5" fill="#FFFFFF" />
      <rect x="28" y="12.5" width="24" height="13" rx="6.5" fill="#C6F432" />
    </svg>
  );
}

export function Logo({ dark = false }: { dark?: boolean }) {
  // white label (Enterprise edition): custom name / logo of the admin interface; null in the community edition
  const brand = useEdition().info?.branding;
  if (brand) {
    return (
      <div className="flex min-w-0 items-center gap-2">
        {brand.logo_url ? <img src={brand.logo_url} alt="" className="h-7 max-w-[120px] shrink-0 object-contain" /> : !brand.app_name && <LogoMark />}
        {brand.app_name && <span className={cx('truncate font-display text-[17px] font-extrabold tracking-[-0.02em]', dark ? 'text-white' : 'text-ink')}>{brand.app_name}</span>}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <LogoMark />
      <span className={cx('font-display text-[19px] font-extrabold tracking-[-0.035em]', dark ? 'text-white' : 'text-ink')}>scalo</span>
    </div>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  if (!user) return null;
  return (
    <div ref={ref} className="relative">
      {open && (
        <div className="absolute right-0 bottom-full left-0 mb-2 animate-pop-in overflow-hidden rounded-xl bg-white p-1 shadow-pop">
          <button
            onClick={() => {
              setOpen(false);
              navigate('/settings');
            }}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-slate-700 hover:bg-slate-100"
          >
            <Settings size={15} className="text-slate-500" /> Paramètres
          </button>
          <button
            onClick={() => {
              setOpen(false);
              navigate('/developers');
            }}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-slate-700 hover:bg-slate-100"
          >
            <Blocks size={15} className="text-slate-500" /> Développeurs
          </button>
          <button
            onClick={() => {
              logout();
              navigate('/login');
            }}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-rose-600 hover:bg-rose-50"
          >
            <LogOut size={15} /> Se déconnecter
          </button>
        </div>
      )}
      <button
        onClick={() => setOpen((o) => !o)}
        className={cx('flex w-full items-center gap-2.5 rounded-xl p-1.5 text-left transition-colors hover:bg-white/5', open && 'bg-white/5')}
      >
        <Avatar text={initials(user.name || user.email)} seed={user.email} size={30} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-white">{user.name || 'Mon compte'}</span>
          <span className="block truncate text-xs text-brand-300">{user.email}</span>
        </span>
        <ChevronsUpDown size={15} className="text-brand-300" />
      </button>
    </div>
  );
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-16 items-center px-4">
        <Logo dark />
      </div>
      <nav className="scalo-scroll-dark flex-1 space-y-0.5 overflow-y-auto px-2.5 py-3">
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            onClick={onNavigate}
            className={({ isActive }) =>
              cx(
                'group relative flex items-center gap-2.5 rounded-full px-3 py-2 text-sm font-medium transition-colors',
                isActive ? 'bg-white/10 text-white' : 'text-brand-200 hover:bg-white/5 hover:text-white',
              )
            }
          >
            {({ isActive }) => (
              <>
                <n.icon size={17} strokeWidth={1.9} className={cx('shrink-0', isActive ? 'text-lime-400' : 'text-brand-300 group-hover:text-white')} />
                {n.label}
                {isActive && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-lime-400" />}
              </>
            )}
          </NavLink>
        ))}
      </nav>
      <div className="p-2.5">
        <UserMenu />
      </div>
    </div>
  );
}

export function Layout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setMobileOpen(false), [location.pathname]);

  return (
    <div className="flex min-h-full">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 bg-ink lg:block">
        <SidebarContent />
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 animate-fade-in bg-slate-900/40" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 animate-slide-in-left bg-ink shadow-pop">
            <button className="absolute top-4 right-3 rounded-lg p-1.5 text-brand-300 hover:bg-white/10" onClick={() => setMobileOpen(false)} aria-label="Fermer le menu">
              <X size={18} />
            </button>
            <SidebarContent onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col lg:pl-60">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 bg-ink px-4 lg:hidden">
          <button onClick={() => setMobileOpen(true)} className="rounded-lg p-1.5 text-brand-200 hover:bg-white/10" aria-label="Ouvrir le menu">
            <Menu size={20} />
          </button>
          <Logo dark />
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-9">
          {eeWeb && <eeWeb.Banner />}
          <Outlet />
        </main>
      </div>
    </div>
  );
}
