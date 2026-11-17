import React, { useEffect, useState } from 'react';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import {
  LayoutDashboard,
  ScanBarcode,
  PackageSearch,
  Send,
  ArrowRightLeft,
  Layers,
  History,
  Users,
  LogOut,
  Menu,
  X,
  Building2,
  FileSpreadsheet,
} from 'lucide-react';
import { api } from './api';
import { auth } from './firebase';
import { ensureInitialSetup, syncSignedInUser } from './firestoreWms';
import type {
  AuthUser,
  Company,
  InventoryLot,
  NavSection,
  PendingOutboundItem,
  PendingScanItem,
} from './types';
import { LoginView } from './components/LoginView';
import { OverviewReportsView } from './components/OverviewReportsView';
import { ReceivingView } from './components/ReceivingView';
import { UploadedFilesView } from './components/UploadedFilesView';
import { InventoryView } from './components/InventoryView';
import { OutboundFifoView } from './components/OutboundFifoView';
import { TransferView } from './components/TransferView';
import { BomView } from './components/BomView';
import { MovementsView } from './components/MovementsView';
import { UsersAdminView } from './components/UsersAdminView';

const NAV_ITEMS: Array<{
  id: NavSection;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  adminOnly?: boolean;
}> = [
  { id: 'overview', label: 'Summary Report', icon: LayoutDashboard },
  { id: 'receiving', label: 'Container Receiving', icon: ScanBarcode },
  { id: 'uploaded_files', label: 'Uploaded File', icon: FileSpreadsheet },
  { id: 'inventory', label: 'Inventory Search', icon: PackageSearch },
  { id: 'outbound', label: 'FIFO Outbound', icon: Send },
  { id: 'transfer', label: 'Stock Transfer', icon: ArrowRightLeft },
  { id: 'bom', label: 'Bills of Materials', icon: Layers },
  { id: 'movements', label: 'Movement History', icon: History },
  { id: 'users', label: 'User Admin', icon: Users, adminOnly: true },
];

export default function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [booting, setBooting] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<number>(1);
  const [activeSection, setActiveSection] = useState<NavSection>('overview');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Per-company staged receiving & outbound scans in memory
  const [pendingByCompany, setPendingByCompany] = useState<Record<number, PendingScanItem[]>>({});
  const [pendingOutboundByCompany, setPendingOutboundByCompany] = useState<
    Record<number, PendingOutboundItem[]>
  >({});

  // Cross-view quick-action context
  const [transferLot, setTransferLot] = useState<InventoryLot | null>(null);
  const [outboundPart, setOutboundPart] = useState<string | null>(null);

  async function handleLogout() {
    try {
      await signOut(auth);
    } catch {
      // Ignore sign-out errors
    }
    setUser(null);
    setAuthError(null);
    setCompanies([]);
    setPendingByCompany({});
    setPendingOutboundByCompany({});
    setActiveSection('overview');
  }

  async function loadCompaniesList() {
    const { companies: compList } = await api.getCompanies();
    setCompanies(compList);
    if (compList.length > 0) {
      setSelectedCompanyId((prev) =>
        compList.some((c) => c.id === prev) ? prev : compList[0].id
      );
    }
  }

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (fbUser) => {
      if (!fbUser) {
        setUser(null);
        setCompanies([]);
        setBooting(false);
        return;
      }

      setBooting(true);
      setAuthError(null);
      try {
        const me = await syncSignedInUser(fbUser);
        await ensureInitialSetup();
        setUser(me);
        await loadCompaniesList();
      } catch (err) {
        setAuthError(err instanceof Error ? err.message : 'Unable to initialize warehouse profile.');
        try {
          await signOut(auth);
        } catch {
          // Ignore sign-out error
        }
        setUser(null);
      } finally {
        setBooting(false);
      }
    });

    return () => unsubscribe();
  }, []);

  // Warn before closing/reloading if pending receiving or outbound scans exist
  const totalPendingCount =
    Object.values(pendingByCompany).reduce((sum, list) => sum + list.length, 0) +
    Object.values(pendingOutboundByCompany).reduce((sum, list) => sum + list.length, 0);

  useEffect(() => {
    if (totalPendingCount === 0) return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [totalPendingCount]);

  if (booting) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center text-sm text-slate-500">
        Connecting to Cloud Firestore...
      </div>
    );
  }

  if (!user) {
    return <LoginView initialError={authError} />;
  }

  const activeCompany = companies.find((c) => c.id === selectedCompanyId) || companies[0];
  const visibleNav = NAV_ITEMS.filter((item) => !item.adminOnly || user.role === 'admin');
  const currentNavLabel = visibleNav.find((n) => n.id === activeSection)?.label || 'Overview';
  const currentPendingScans = activeCompany ? pendingByCompany[activeCompany.id] || [] : [];
  const currentPendingOutbound = activeCompany
    ? pendingOutboundByCompany[activeCompany.id] || []
    : [];

  function setCurrentPendingScans(updater: React.SetStateAction<PendingScanItem[]>) {
    if (!activeCompany) return;
    const cid = activeCompany.id;
    setPendingByCompany((prev) => {
      const current = prev[cid] || [];
      const next = typeof updater === 'function' ? updater(current) : updater;
      return { ...prev, [cid]: next };
    });
  }

  function setCurrentPendingOutbound(updater: React.SetStateAction<PendingOutboundItem[]>) {
    if (!activeCompany) return;
    const cid = activeCompany.id;
    setPendingOutboundByCompany((prev) => {
      const current = prev[cid] || [];
      const next = typeof updater === 'function' ? updater(current) : updater;
      return { ...prev, [cid]: next };
    });
  }

  function handleNavigate(section: NavSection) {
    setActiveSection(section);
    setMobileMenuOpen(false);
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex">
      {/* Mobile Sidebar Backdrop */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 z-30 bg-slate-900/40 lg:hidden"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-64 bg-slate-900 text-slate-200 flex flex-col border-r border-slate-800 transition-transform duration-200 lg:static lg:translate-x-0 ${
          mobileMenuOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="h-16 px-5 border-b border-slate-800 flex items-center justify-between shrink-0">
          <span className="text-lg font-bold tracking-tight text-white whitespace-nowrap">
            NexusWMS
          </span>
          <button
            type="button"
            onClick={() => setMobileMenuOpen(false)}
            aria-label="Close navigation menu"
            className="lg:hidden p-1.5 rounded-md text-slate-400 hover:text-white hover:bg-slate-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Company Selector in Sidebar */}
        <div className="px-4 py-4 border-b border-slate-800">
          <label htmlFor="sidebar-company" className="flex items-center gap-1.5 text-xs font-medium text-slate-400 mb-2">
            <Building2 className="w-3.5 h-3.5" />
            <span>Active Company</span>
          </label>
          <select
            id="sidebar-company"
            value={selectedCompanyId}
            onChange={(e) => {
              setSelectedCompanyId(Number(e.target.value));
              setTransferLot(null);
              setOutboundPart(null);
            }}
            className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-medium text-white focus:border-blue-500 focus:outline-none"
          >
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code === c.name ? c.name : `${c.code} — ${c.name.split(' (')[0]}`}
              </option>
            ))}
          </select>
        </div>

        {/* Navigation Links */}
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {visibleNav.map((item) => {
            const Icon = item.icon;
            const active = activeSection === item.id;
            const badgeCount =
              item.id === 'receiving' && currentPendingScans.length > 0
                ? currentPendingScans.length
                : item.id === 'outbound' && currentPendingOutbound.length > 0
                ? currentPendingOutbound.length
                : 0;

            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleNavigate(item.id)}
                className={`w-full flex items-center justify-between gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-blue-700 text-white'
                    : 'text-slate-300 hover:bg-slate-800/80 hover:text-white'
                }`}
              >
                <span className="flex items-center gap-2.5 truncate">
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </span>
                {badgeCount > 0 && (
                  <span className="font-mono tabular-nums text-xs font-semibold text-blue-200">
                    {badgeCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Account Footer */}
        <div className="p-4 border-t border-slate-800 space-y-3">
          <div className="text-xs">
            <div className="font-semibold text-white truncate">{user.fullName}</div>
            <div className="text-slate-400 font-mono mt-0.5 truncate">
              {user.username} · {user.role}
            </div>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            className="w-full inline-flex items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 transition-colors whitespace-nowrap"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Sign Out</span>
          </button>
        </div>
      </aside>

      {/* Main Content Shell */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top Bar Contract: Breadcrumb on left, 1 primary company/receiving action on right */}
        <header className="h-16 bg-white border-b border-slate-200 px-4 sm:px-8 flex items-center justify-between gap-8 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open navigation menu"
              className="lg:hidden p-2 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50"
            >
              <Menu className="w-4 h-4" />
            </button>
            <div className="flex items-center gap-2 text-sm text-slate-500 min-w-0">
              <span className="font-mono font-semibold text-slate-900 whitespace-nowrap shrink-0">
                {activeCompany?.code || 'WMS'}
              </span>
              <span aria-hidden="true">/</span>
              <span className="font-medium text-slate-700 truncate">{currentNavLabel}</span>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => handleNavigate('receiving')}
              className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
            >
              <ScanBarcode className="w-3.5 h-3.5" />
              <span>
                {currentPendingScans.length > 0
                  ? `Receiving (${currentPendingScans.length} staged)`
                  : 'Scan Container'}
              </span>
            </button>
          </div>
        </header>

        {/* Active Module Viewport */}
        <main className="flex-1 p-4 sm:p-8 max-w-[1440px] w-full mx-auto">
          {!activeCompany ? (
            <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-600">
              No companies configured.
            </div>
          ) : (
            <>
              {activeSection === 'overview' && (
                <OverviewReportsView company={activeCompany} onNavigate={handleNavigate} />
              )}
              {activeSection === 'receiving' && (
                <ReceivingView
                  company={activeCompany}
                  pendingScans={currentPendingScans}
                  onPendingScansChange={setCurrentPendingScans}
                  onNavigate={handleNavigate}
                />
              )}
              {activeSection === 'uploaded_files' && (
                <UploadedFilesView
                  company={activeCompany}
                  companies={companies}
                  user={user}
                  onNavigate={handleNavigate}
                />
              )}
              {activeSection === 'inventory' && (
                <InventoryView
                  company={activeCompany}
                  onQuickTransfer={(lot) => {
                    setTransferLot(lot);
                    setActiveSection('transfer');
                  }}
                  onQuickOutbound={(part) => {
                    setOutboundPart(part);
                    setActiveSection('outbound');
                  }}
                />
              )}
              {activeSection === 'outbound' && (
                <OutboundFifoView
                  company={activeCompany}
                  preselectedPart={outboundPart}
                  pendingScans={currentPendingOutbound}
                  onPendingScansChange={setCurrentPendingOutbound}
                />
              )}
              {activeSection === 'transfer' && (
                <TransferView company={activeCompany} preselectedLot={transferLot} />
              )}
              {activeSection === 'bom' && <BomView company={activeCompany} user={user} />}
              {activeSection === 'movements' && <MovementsView company={activeCompany} />}
              {activeSection === 'users' && <UsersAdminView currentUser={user} />}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
