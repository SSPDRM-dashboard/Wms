import React, { useEffect, useState } from 'react';
import { RefreshCw, ArrowUpRight, ScanBarcode, PackageSearch, Send } from 'lucide-react';
import { api } from '../api';
import type { Company, NavSection, SummaryReport } from '../types';

interface OverviewReportsViewProps {
  company: Company;
  onNavigate: (section: NavSection) => void;
}

const MOVEMENT_LABELS: Record<string, string> = {
  RECEIVE: 'Container Receiving',
  OUTBOUND_FIFO: 'FIFO Outbound Issue',
  TRANSFER: 'Location Transfer',
};

export function OverviewReportsView({ company, onNavigate }: OverviewReportsViewProps) {
  const [report, setReport] = useState<SummaryReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadReport() {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getSummaryReport(company.id);
      setReport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load summary report.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadReport();
  }, [company.id]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Inventory &amp; Operations Summary
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            {company.name} · Profile <span className="font-mono text-slate-800">{company.qr_profile}</span>
          </p>
        </div>
        <div className="flex items-center gap-2.5 flex-wrap">
          <button
            type="button"
            onClick={() => void loadReport()}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
          <button
            type="button"
            onClick={() => onNavigate('receiving')}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 transition-colors whitespace-nowrap shrink-0"
          >
            <ScanBarcode className="w-4 h-4" />
            <span>Open Scanner Receiving</span>
          </button>
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {loading && !report ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-28 rounded-xl border border-slate-200 bg-white p-5 animate-pulse" />
          ))}
        </div>
      ) : report ? (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
             <div className="rounded-xl border border-slate-200 bg-white p-5">
              <div className="text-xs font-medium text-slate-500">Total On-Hand Units</div>
              <div className="mt-2 text-3xl font-bold font-mono tabular-nums text-slate-900">
                {(report?.stockTotals?.total_units ?? 0).toLocaleString()}
              </div>
              <div className="mt-1.5 text-xs text-slate-500">
                Across {report?.stockTotals?.active_boxes ?? 0} active boxes
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <div className="text-xs font-medium text-slate-500">Distinct SKUs in Stock</div>
              <div className="mt-2 text-3xl font-bold font-mono tabular-nums text-slate-900">
                {report?.stockTotals?.distinct_skus ?? 0}
              </div>
              <div className="mt-1.5 text-xs text-slate-500">
                Company-isolated catalog
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <div className="text-xs font-medium text-slate-500">Active Warehouse Locations</div>
              <div className="mt-2 text-3xl font-bold font-mono tabular-nums text-slate-900">
                {report?.stockTotals?.active_locations ?? 0}
              </div>
              <div className="mt-1.5 text-xs text-slate-500">
                Docks, racks &amp; staging zones
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <div className="text-xs font-medium text-slate-500">Completed Containers</div>
              <div className="mt-2 text-3xl font-bold font-mono tabular-nums text-slate-900">
                {report?.containerStats?.total_containers ?? 0}
              </div>
              <div className="mt-1.5 text-xs text-slate-500">
                {(report?.containerStats?.received_boxes ?? 0).toLocaleString()} total boxes committed
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-7 rounded-xl border border-slate-200 bg-white overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">Top Stocked SKUs (FIFO Queue)</h2>
                  <p className="text-xs text-slate-500 mt-0.5">Oldest active receipt timestamp shown per part number</p>
                </div>
                <button
                  type="button"
                  onClick={() => onNavigate('inventory')}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:text-blue-800 whitespace-nowrap shrink-0"
                >
                  <span>Full Inventory</span>
                  <ArrowUpRight className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50/70 text-left text-xs font-medium text-slate-500">
                      <th className="px-5 py-2.5">Part Number</th>
                      <th className="px-4 py-2.5 text-right">On-Hand Qty</th>
                      <th className="px-4 py-2.5 text-right">Boxes</th>
                      <th className="px-5 py-2.5 text-right">Oldest Lot (FIFO)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {(!report?.topParts || report.topParts.length === 0) ? (
                      <tr>
                        <td colSpan={4} className="px-5 py-8 text-center text-sm text-slate-500">
                          No active inventory for {company.code}. Complete a container receipt to populate stock.
                        </td>
                      </tr>
                    ) : (
                      report.topParts.map((row) => (
                        <tr key={row.part_number} className="hover:bg-slate-50/80 transition-colors">
                          <td className="px-5 py-3 font-mono font-medium text-slate-900">{row.part_number}</td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums font-semibold text-slate-900">
                            {row.total_qty.toLocaleString()}
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-600">
                            {row.box_count}
                          </td>
                          <td className="px-5 py-3 text-right font-mono tabular-nums text-xs text-slate-500">
                            {new Date(row.oldest_lot).toLocaleDateString()}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="lg:col-span-5 space-y-6">
              <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
                  <h2 className="text-base font-semibold text-slate-900">Stock by Location</h2>
                  <button
                    type="button"
                    onClick={() => onNavigate('transfer')}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:text-blue-800 whitespace-nowrap shrink-0"
                  >
                    <span>Transfer Stock</span>
                    <ArrowUpRight className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="divide-y divide-slate-100">
                  {(!report?.byLocation || report.byLocation.length === 0) ? (
                    <div className="px-5 py-6 text-sm text-slate-500 text-center">No stocked locations.</div>
                  ) : (
                    report.byLocation.map((loc) => (
                      <div key={loc.location} className="px-5 py-3 flex items-center justify-between gap-4">
                        <div>
                          <div className="font-mono text-sm font-semibold text-slate-900">{loc.location}</div>
                          <div className="text-xs text-slate-500">
                            {loc.sku_count} SKUs · {loc.box_count} boxes
                          </div>
                        </div>
                        <div className="font-mono tabular-nums text-sm font-semibold text-slate-900">
                          {loc.total_qty.toLocaleString()} units
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
                  <h2 className="text-base font-semibold text-slate-900">Movement Activity</h2>
                  <button
                    type="button"
                    onClick={() => onNavigate('movements')}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:text-blue-800 whitespace-nowrap shrink-0"
                  >
                    <span>View Ledger</span>
                    <ArrowUpRight className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="divide-y divide-slate-100">
                  {(!report?.movementBreakdown || report.movementBreakdown.length === 0) ? (
                    <div className="px-5 py-6 text-sm text-slate-500 text-center">No recorded movements yet.</div>
                  ) : (
                    report.movementBreakdown.map((m) => (
                      <div key={m.movement_type} className="px-5 py-3 flex items-center justify-between gap-4">
                        <div>
                          <div className="text-sm font-medium text-slate-900">
                            {MOVEMENT_LABELS[m.movement_type] || m.movement_type}
                          </div>
                          <div className="text-xs text-slate-500 font-mono tabular-nums">
                            {m.tx_count} transactions
                          </div>
                        </div>
                        <div className="font-mono tabular-nums text-sm font-semibold text-slate-900">
                          {m.total_units.toLocaleString()} units
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-5 flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm font-semibold text-slate-900">Quick Warehouse Actions</div>
                  <div className="text-xs text-slate-500 mt-0.5">Search stock lots or issue FIFO orders</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => onNavigate('inventory')}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap"
                  >
                    <PackageSearch className="w-3.5 h-3.5" />
                    <span>Search</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onNavigate('outbound')}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 transition-colors whitespace-nowrap"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>Issue FIFO</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
