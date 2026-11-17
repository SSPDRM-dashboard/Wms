import React, { useEffect, useState } from 'react';
import { Search, Download } from 'lucide-react';
import { api } from '../api';
import { exportRowsToCsv } from '../utils/audio';
import type { Company, MovementRecord } from '../types';

interface MovementsViewProps {
  company: Company;
}

const TYPE_OPTIONS = [
  { value: '', label: 'All Movements' },
  { value: 'RECEIVE', label: 'Receiving' },
  { value: 'OUTBOUND_FIFO', label: 'FIFO Outbound' },
  { value: 'TRANSFER', label: 'Transfers' },
];

export function MovementsView({ company }: MovementsViewProps) {
  const [type, setType] = useState('');
  const [search, setSearch] = useState('');
  const [movements, setMovements] = useState<MovementRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadMovements(activeType = type, activeSearch = search) {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getMovements(company.id, activeType, activeSearch);
      setMovements(res.movements);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load movement ledger.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setType('');
    setSearch('');
    void loadMovements('', '');
  }, [company.id]);

  function handleExportCsv() {
    exportRowsToCsv(
      `${company.code.toLowerCase()}-movement-history.csv`,
      ['ID', 'Timestamp', 'Type', 'Part Number', 'Box ID', 'Batch Ref', 'Qty Delta', 'From', 'To', 'Reference', 'User'],
      movements.map((m) => [
        m.id,
        m.created_at,
        m.movement_type,
        m.part_number,
        m.box_id,
        m.batch_ref,
        m.qty_delta,
        m.from_location,
        m.to_location,
        m.reference_code,
        m.performed_by,
      ])
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Movement History Ledger</h1>
          <p className="mt-1 text-sm text-slate-600">
            {company.name} · Immutable audit trail of receipts, transfers, and FIFO outbound picks.
          </p>
        </div>

        <button
          type="button"
          onClick={handleExportCsv}
          disabled={movements.length === 0}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
        >
          <Download className="w-4 h-4 text-slate-600" />
          <span>Export CSV</span>
        </button>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => {
              const val = e.target.value;
              setSearch(val);
              void loadMovements(type, val);
            }}
            placeholder="Filter by part number, box ID, batch, reference, or location..."
            className="w-full rounded-lg border border-slate-300 pl-9 pr-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
          />
        </div>

        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg overflow-x-auto shrink-0">
          {TYPE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                setType(opt.value);
                void loadMovements(opt.value, search);
              }}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                type === opt.value
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}

      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70 text-left text-xs font-medium text-slate-500">
                <th className="px-5 py-2.5">Timestamp</th>
                <th className="px-4 py-2.5">Operation</th>
                <th className="px-4 py-2.5">Part / Box</th>
                <th className="px-4 py-2.5 text-right">Qty</th>
                <th className="px-4 py-2.5">Route</th>
                <th className="px-4 py-2.5">Reference</th>
                <th className="px-5 py-2.5 text-right">Operator</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-5 py-8 text-center text-sm text-slate-500">
                    Loading movement ledger...
                  </td>
                </tr>
              ) : movements.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-5 py-10 text-center text-sm text-slate-500">
                    No matching movements found.
                  </td>
                </tr>
              ) : (
                movements.map((m) => (
                  <tr key={m.id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="px-5 py-3 font-mono tabular-nums text-xs text-slate-500 whitespace-nowrap">
                      {new Date(m.created_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-xs font-semibold whitespace-nowrap">
                      <span
                        className={
                          m.movement_type === 'RECEIVE'
                            ? 'text-emerald-700'
                            : m.movement_type === 'OUTBOUND_FIFO'
                            ? 'text-amber-700'
                            : 'text-blue-700'
                        }
                      >
                        {m.movement_type}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-mono font-medium text-slate-900">{m.part_number}</div>
                      <div className="font-mono text-xs text-slate-500">
                        {m.box_id}
                        {m.batch_ref ? ` · ${m.batch_ref}` : ''}
                      </div>
                    </td>
                    <td
                      className={`px-4 py-3 text-right font-mono tabular-nums font-semibold ${
                        m.movement_type === 'RECEIVE'
                          ? 'text-emerald-700'
                          : m.movement_type === 'OUTBOUND_FIFO'
                          ? 'text-red-700'
                          : 'text-slate-900'
                      }`}
                    >
                      {m.movement_type === 'RECEIVE'
                        ? `+${m.qty_delta}`
                        : m.movement_type === 'OUTBOUND_FIFO'
                        ? m.qty_delta
                        : m.qty_delta}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-700 whitespace-nowrap">
                      {m.from_location} → {m.to_location}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-600">{m.reference_code || '—'}</td>
                    <td className="px-5 py-3 text-right font-mono text-xs text-slate-600">{m.performed_by}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
