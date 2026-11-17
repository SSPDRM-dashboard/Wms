import React, { useEffect, useState } from 'react';
import { ArrowRightLeft, CheckCircle2, AlertTriangle } from 'lucide-react';
import { api } from '../api';
import type { Company, InventoryLot } from '../types';

interface TransferViewProps {
  company: Company;
  preselectedLot?: InventoryLot | null;
}

const PRESET_LOCATIONS = ['A-01-R02', 'A-02-R01', 'B-ZONE-01', 'B-ZONE-03', 'QC-HOLD', 'PACK-STAGE-01'];

export function TransferView({ company, preselectedLot }: TransferViewProps) {
  const [lots, setLots] = useState<InventoryLot[]>([]);
  const [selectedLotId, setSelectedLotId] = useState<string>('');
  const [qty, setQty] = useState('');
  const [toLocation, setToLocation] = useState('A-02-R01');
  const [referenceCode, setReferenceCode] = useState(
    () => `TR-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}`
  );
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  async function loadLots(targetLotId?: number) {
    setLoading(true);
    try {
      const res = await api.getInventory(company.id);
      setLots(res.lots);
      const preferred =
        (targetLotId && res.lots.find((l) => l.id === targetLotId)) ||
        (preselectedLot && res.lots.find((l) => l.id === preselectedLot.id)) ||
        res.lots[0];
      if (preferred) {
        setSelectedLotId(String(preferred.id));
        setQty(String(preferred.qty));
      } else {
        setSelectedLotId('');
        setQty('');
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setFeedback(null);
    void loadLots(preselectedLot?.id);
  }, [company.id, preselectedLot?.id]);

  const activeLot = lots.find((l) => String(l.id) === selectedLotId);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!activeLot) return;
    const numQty = Number(qty);
    if (!Number.isInteger(numQty) || numQty <= 0) {
      setFeedback({ kind: 'error', text: 'Transfer quantity must be a positive integer.' });
      return;
    }

    setSubmitting(true);
    setFeedback(null);
    try {
      const res = await api.transferStock({
        company_id: company.id,
        lot_id: activeLot.id,
        qty: numQty,
        to_location: toLocation.trim(),
        reference_code: referenceCode.trim() || 'TRANSFER',
      });
      setFeedback({
        kind: 'success',
        text: `Moved ${res.qtyTransferred} units of ${res.partNumber} (${res.boxId}) from ${res.fromLocation} to ${res.toLocation}.`,
      });
      await loadLots(res.lotId);
    } catch (err) {
      setFeedback({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Stock transfer failed.',
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Stock Transfer</h1>
        <p className="mt-1 text-sm text-slate-600">
          {company.name} · Move full boxes or split partial quantities between warehouse bins while preserving FIFO receipt dates.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <form
          onSubmit={handleSubmit}
          className="lg:col-span-6 rounded-xl border border-slate-200 bg-white p-6 space-y-4"
        >
          <h2 className="text-base font-semibold text-slate-900">Transfer Ticket</h2>

          <div>
            <label htmlFor="tr-lot" className="block text-xs font-medium text-slate-600">
              Source Box / Inventory Lot
            </label>
            <select
              id="tr-lot"
              value={selectedLotId}
              onChange={(e) => {
                setSelectedLotId(e.target.value);
                const found = lots.find((l) => String(l.id) === e.target.value);
                if (found) setQty(String(found.qty));
              }}
              className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm font-mono text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
            >
              {lots.length === 0 ? (
                <option value="">No active lots available</option>
              ) : (
                lots.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.box_id} · {l.part_number} · {l.qty} units @ {l.location}
                  </option>
                ))
              )}
            </select>
          </div>

          {activeLot && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5 text-xs grid grid-cols-3 gap-3">
              <div>
                <div className="text-slate-500">Current Location</div>
                <div className="mt-0.5 font-mono font-semibold text-slate-900">{activeLot.location}</div>
              </div>
              <div>
                <div className="text-slate-500">Available Qty</div>
                <div className="mt-0.5 font-mono tabular-nums font-semibold text-slate-900">
                  {activeLot.qty.toLocaleString()}
                </div>
              </div>
              <div>
                <div className="text-slate-500">Batch Ref</div>
                <div className="mt-0.5 font-mono text-slate-800">{activeLot.batch_ref || '—'}</div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="tr-qty" className="block text-xs font-medium text-slate-600">
                Quantity to Move
              </label>
              <input
                id="tr-qty"
                type="number"
                min={1}
                max={activeLot?.qty || undefined}
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                required
                className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm font-mono tabular-nums text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
              />
            </div>

            <div>
              <label htmlFor="tr-ref" className="block text-xs font-medium text-slate-600">
                Transfer Reference
              </label>
              <input
                id="tr-ref"
                type="text"
                value={referenceCode}
                onChange={(e) => setReferenceCode(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm font-mono text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
              />
            </div>
          </div>

          <div>
            <label htmlFor="tr-dest" className="block text-xs font-medium text-slate-600">
              Destination Location / Bin
            </label>
            <input
              id="tr-dest"
              type="text"
              value={toLocation}
              onChange={(e) => setToLocation(e.target.value)}
              required
              className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm font-mono text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
            />
            <div className="mt-2 flex items-center gap-1.5 flex-wrap">
              <span className="text-xs text-slate-500">Presets:</span>
              {PRESET_LOCATIONS.map((loc) => (
                <button
                  key={loc}
                  type="button"
                  onClick={() => setToLocation(loc)}
                  className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-mono text-slate-700 hover:bg-slate-100 whitespace-nowrap"
                >
                  {loc}
                </button>
              ))}
            </div>
          </div>

          {feedback && (
            <div
              role="status"
              className={`rounded-lg border px-3.5 py-2.5 text-sm flex items-start gap-2 ${
                feedback.kind === 'success'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                  : 'border-red-200 bg-red-50 text-red-900'
              }`}
            >
              {feedback.kind === 'success' ? (
                <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-emerald-700" />
              ) : (
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-red-700" />
              )}
              <span>{feedback.text}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || !activeLot}
            className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-50 transition-colors whitespace-nowrap"
          >
            <ArrowRightLeft className="w-4 h-4" />
            <span>{submitting ? 'Transferring...' : 'Execute Stock Transfer'}</span>
          </button>
        </form>

        <div className="lg:col-span-6 rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200">
            <h2 className="text-base font-semibold text-slate-900">Active Lots Available to Transfer</h2>
          </div>
          <div className="overflow-x-auto max-h-[460px] overflow-y-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-left text-xs font-medium text-slate-500">
                  <th className="px-5 py-2.5">Box ID</th>
                  <th className="px-4 py-2.5">Part Number</th>
                  <th className="px-4 py-2.5">Location</th>
                  <th className="px-5 py-2.5 text-right">Qty</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading ? (
                  <tr>
                    <td colSpan={4} className="px-5 py-8 text-center text-sm text-slate-500">
                      Loading lots...
                    </td>
                  </tr>
                ) : lots.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-5 py-8 text-center text-sm text-slate-500">
                      No lots in stock.
                    </td>
                  </tr>
                ) : (
                  lots.map((l) => (
                    <tr
                      key={l.id}
                      onClick={() => {
                        setSelectedLotId(String(l.id));
                        setQty(String(l.qty));
                      }}
                      className={`cursor-pointer transition-colors ${
                        String(l.id) === selectedLotId ? 'bg-blue-50/70' : 'hover:bg-slate-50'
                      }`}
                    >
                      <td className="px-5 py-2.5 font-mono font-medium text-slate-900">{l.box_id}</td>
                      <td className="px-4 py-2.5 font-mono text-slate-700">{l.part_number}</td>
                      <td className="px-4 py-2.5 font-mono text-xs text-slate-600">{l.location}</td>
                      <td className="px-5 py-2.5 text-right font-mono tabular-nums font-semibold text-slate-900">
                        {l.qty.toLocaleString()}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
