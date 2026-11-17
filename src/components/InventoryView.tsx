import React, { useEffect, useState } from 'react';
import { Search, Download, ArrowRightLeft, Send } from 'lucide-react';
import { api } from '../api';
import { exportRowsToCsv } from '../utils/audio';
import type { Company, InventoryLot, SkuSummary } from '../types';

interface InventoryViewProps {
  company: Company;
  onQuickTransfer: (lot: InventoryLot) => void;
  onQuickOutbound: (partNumber: string) => void;
}

export function InventoryView({
  company,
  onQuickTransfer,
  onQuickOutbound,
}: InventoryViewProps) {
  const [search, setSearch] = useState('');
  const [location, setLocation] = useState('');
  const [viewMode, setViewMode] = useState<'lots' | 'sku'>('lots');
  const [lots, setLots] = useState<InventoryLot[]>([]);
  const [skuSummary, setSkuSummary] = useState<SkuSummary[]>([]);
  const [locations, setLocations] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadInventory(activeSearch = search, activeLoc = location) {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getInventory(company.id, activeSearch, activeLoc);
      setLots(data.lots);
      setSkuSummary(data.skuSummary);
      setLocations(data.locations);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load inventory.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLocation('');
    setSearch('');
    void loadInventory('', '');
  }, [company.id]);

  function handleExportCsv() {
    if (viewMode === 'lots') {
      exportRowsToCsv(
        `${company.code.toLowerCase()}-inventory-lots.csv`,
        ['Lot ID', 'Part Number', 'Box ID', 'Qty', 'Initial Qty', 'Batch Ref', 'Location', 'Pallet Ref', 'Container', 'Received At'],
        lots.map((l) => [
          l.id,
          l.part_number,
          l.box_id,
          l.qty,
          l.initial_qty,
          l.batch_ref,
          l.location,
          l.pallet_ref,
          l.container_code || '',
          l.received_at,
        ])
      );
    } else {
      exportRowsToCsv(
        `${company.code.toLowerCase()}-inventory-sku-summary.csv`,
        ['Part Number', 'Total Qty', 'Active Boxes', 'Locations', 'Oldest Lot (FIFO)'],
        skuSummary.map((s) => [
          s.part_number,
          s.total_qty,
          s.box_count,
          s.location_count,
          s.oldest_received_at,
        ])
      );
    }
  }

  const totalUnits = lots.reduce((sum, l) => sum + l.qty, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Inventory Search &amp; Export
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            {company.name} · <span className="font-mono tabular-nums">{totalUnits.toLocaleString()}</span> units across{' '}
            <span className="font-mono tabular-nums">{lots.length}</span> active lots · Read-only ledger
          </p>
        </div>

        <div className="flex items-center gap-2.5 flex-wrap shrink-0">
          <button
            type="button"
            onClick={handleExportCsv}
            disabled={(viewMode === 'lots' ? lots.length : skuSummary.length) === 0}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
          >
            <Download className="w-4 h-4 text-slate-600" />
            <span>Export CSV</span>
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex flex-1 items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => {
                const val = e.target.value;
                setSearch(val);
                void loadInventory(val, location);
              }}
              placeholder="Search part number, box ID, batch, pallet, location..."
              className="w-full rounded-lg border border-slate-300 pl-9 pr-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
            />
          </div>

          <select
            aria-label="Filter by location"
            value={location}
            onChange={(e) => {
              const val = e.target.value;
              setLocation(val);
              void loadInventory(search, val);
            }}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
          >
            <option value="">All Locations</option>
            {locations.map((loc) => (
              <option key={loc} value={loc}>
                {loc}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg shrink-0 self-start md:self-auto">
          <button
            type="button"
            onClick={() => setViewMode('lots')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
              viewMode === 'lots' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Box Lots (FIFO Order)
          </button>
          <button
            type="button"
            onClick={() => setViewMode('sku')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
              viewMode === 'sku' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            SKU Summary
          </button>
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}

      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-sm text-slate-500">Loading inventory...</div>
        ) : viewMode === 'lots' ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-left text-xs font-medium text-slate-500">
                  <th className="px-5 py-2.5">Part Number</th>
                  <th className="px-4 py-2.5">Box ID</th>
                  <th className="px-4 py-2.5 text-right">Qty</th>
                  <th className="px-4 py-2.5">Batch / Pallet</th>
                  <th className="px-4 py-2.5">Location</th>
                  <th className="px-4 py-2.5">Received (FIFO)</th>
                  <th className="px-5 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {lots.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-5 py-10 text-center text-sm text-slate-500">
                      No matching stock lots found for {company.code}.
                    </td>
                  </tr>
                ) : (
                  lots.map((lot) => (
                    <tr key={lot.id} className="hover:bg-slate-50/80 transition-colors">
                      <td className="px-5 py-3 font-mono font-semibold text-slate-900">{lot.part_number}</td>
                      <td className="px-4 py-3 font-mono text-slate-800">{lot.box_id}</td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums font-semibold text-slate-900">
                        {lot.qty.toLocaleString()}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-600">
                        {lot.batch_ref || '—'}
                        {lot.pallet_ref ? ` · ${lot.pallet_ref}` : ''}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs font-medium text-slate-800">{lot.location}</td>
                      <td className="px-4 py-3 font-mono tabular-nums text-xs text-slate-500">
                        {new Date(lot.received_at).toLocaleString()}
                      </td>
                      <td className="px-5 py-3 text-right">
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => onQuickTransfer(lot)}
                            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                          >
                            <ArrowRightLeft className="w-3 h-3" />
                            <span>Transfer</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => onQuickOutbound(lot.part_number)}
                            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                          >
                            <Send className="w-3 h-3" />
                            <span>Issue</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-left text-xs font-medium text-slate-500">
                  <th className="px-5 py-2.5">Part Number</th>
                  <th className="px-4 py-2.5 text-right">Total On-Hand</th>
                  <th className="px-4 py-2.5 text-right">Active Boxes</th>
                  <th className="px-4 py-2.5 text-right">Locations</th>
                  <th className="px-4 py-2.5">Oldest Lot (FIFO)</th>
                  <th className="px-5 py-2.5 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {skuSummary.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-5 py-10 text-center text-sm text-slate-500">
                      No matching SKUs found.
                    </td>
                  </tr>
                ) : (
                  skuSummary.map((sku) => (
                    <tr key={sku.part_number} className="hover:bg-slate-50/80 transition-colors">
                      <td className="px-5 py-3 font-mono font-semibold text-slate-900">{sku.part_number}</td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums font-semibold text-slate-900">
                        {sku.total_qty.toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-700">
                        {sku.box_count}
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-700">
                        {sku.location_count}
                      </td>
                      <td className="px-4 py-3 font-mono tabular-nums text-xs text-slate-500">
                        {new Date(sku.oldest_received_at).toLocaleString()}
                      </td>
                      <td className="px-5 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => onQuickOutbound(sku.part_number)}
                          className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                        >
                          <Send className="w-3 h-3" />
                          <span>Issue FIFO</span>
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
