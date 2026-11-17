import React, { useEffect, useState } from 'react';
import { Plus, Trash2, Layers, CheckCircle2, AlertTriangle } from 'lucide-react';
import { api } from '../api';
import type { AuthUser, BomRecord, Company } from '../types';

interface BomViewProps {
  company: Company;
  user: AuthUser;
}

export function BomView({ company, user }: BomViewProps) {
  const canEdit = user.role === 'admin' || user.role === 'supervisor';

  const [boms, setBoms] = useState<BomRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const [parentPart, setParentPart] = useState('');
  const [description, setDescription] = useState('');
  const [revision, setRevision] = useState('A');
  const [lines, setLines] = useState<Array<{ component_part: string; qty_per_assembly: string; notes: string }>>([
    { component_part: '', qty_per_assembly: '1', notes: '' },
  ]);
  const [saving, setSaving] = useState(false);

  async function loadBoms() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getBoms(company.id);
      setBoms(res.boms);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load BOMs.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setFeedback(null);
    void loadBoms();
  }, [company.id]);

  function addLine() {
    setLines((prev) => [...prev, { component_part: '', qty_per_assembly: '1', notes: '' }]);
  }

  function removeLine(idx: number) {
    setLines((prev) => prev.filter((_, i) => i !== idx));
  }

  function populateForEdit(bom: BomRecord) {
    setParentPart(bom.parent_part);
    setDescription(bom.description);
    setRevision(bom.revision);
    setLines(
      bom.items.map((it) => ({
        component_part: it.component_part,
        qty_per_assembly: String(it.qty_per_assembly),
        notes: it.notes,
      }))
    );
    setFeedback(null);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!canEdit) return;
    setSaving(true);
    setFeedback(null);

    try {
      const cleanItems = lines
        .filter((l) => l.component_part.trim())
        .map((l) => ({
          component_part: l.component_part.trim(),
          qty_per_assembly: Number(l.qty_per_assembly),
          notes: l.notes.trim(),
        }));

      await api.saveBom({
        company_id: company.id,
        parent_part: parentPart.trim(),
        description: description.trim(),
        revision: revision.trim() || 'A',
        items: cleanItems,
      });

      setFeedback({
        kind: 'success',
        text: `Saved BOM for ${parentPart.trim()} (Rev ${revision.trim() || 'A'}).`,
      });
      setParentPart('');
      setDescription('');
      setRevision('A');
      setLines([{ component_part: '', qty_per_assembly: '1', notes: '' }]);
      await loadBoms();
    } catch (err) {
      setFeedback({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Failed to save BOM.',
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(bom: BomRecord) {
    if (!canEdit) return;
    try {
      await api.deleteBom(bom.id);
      setFeedback({ kind: 'success', text: `Deleted BOM ${bom.parent_part}.` });
      await loadBoms();
    } catch (err) {
      setFeedback({ kind: 'error', text: err instanceof Error ? err.message : 'Delete failed.' });
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
          Bills of Materials (BOM) &amp; Stock Coverage
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          {company.name} · Live buildability computed against company-isolated on-hand inventory.
        </p>
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {feedback && (
        <div
          role="status"
          className={`rounded-lg border px-4 py-3 text-sm flex items-center gap-2 ${
            feedback.kind === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
              : 'border-red-200 bg-red-50 text-red-900'
          }`}
        >
          {feedback.kind === 'success' ? (
            <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-700" />
          ) : (
            <AlertTriangle className="w-4 h-4 shrink-0 text-red-700" />
          )}
          <span>{feedback.text}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className={canEdit ? 'lg:col-span-7 space-y-4' : 'lg:col-span-12 space-y-4'}>
          {loading ? (
            <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
              Loading BOM definitions...
            </div>
          ) : boms.length === 0 ? (
            <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
              No BOMs stored for {company.code}.
            </div>
          ) : (
            boms.map((bom) => (
              <div key={bom.id} className="rounded-xl border border-slate-200 bg-white overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2.5">
                      <Layers className="w-4 h-4 text-blue-700 shrink-0" />
                      <h2 className="font-mono text-base font-bold text-slate-900">{bom.parent_part}</h2>
                      <span className="text-xs text-slate-500 font-mono">{bom.revision}</span>
                    </div>
                    <p className="text-xs text-slate-600 mt-1">
                      {bom.description || 'No description'} · Updated by {bom.created_by}
                    </p>
                  </div>

                  <div className="flex items-center gap-3 shrink-0">
                    <div className="text-right">
                      <div className="text-[11px] text-slate-500">Max Buildable</div>
                      <div className="font-mono tabular-nums text-base font-bold text-slate-900">
                        {bom.max_buildable.toLocaleString()} assemblies
                      </div>
                    </div>
                    {canEdit && (
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => populateForEdit(bom)}
                          className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDelete(bom)}
                          aria-label={`Delete BOM ${bom.parent_part}`}
                          className="rounded-md p-1.5 text-slate-400 hover:text-red-700 hover:bg-red-50 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50/70 text-left text-xs font-medium text-slate-500">
                        <th className="px-5 py-2">Component Part</th>
                        <th className="px-4 py-2 text-right">Qty / Assembly</th>
                        <th className="px-4 py-2 text-right">On-Hand Stock</th>
                        <th className="px-4 py-2 text-right">Builds Supported</th>
                        <th className="px-5 py-2">Notes</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {bom.items.map((item) => (
                        <tr key={item.id} className="hover:bg-slate-50/70">
                          <td className="px-5 py-2.5 font-mono font-medium text-slate-900">
                            {item.component_part}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-700">
                            {item.qty_per_assembly}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-900">
                            {item.available_qty.toLocaleString()}
                          </td>
                          <td
                            className={`px-4 py-2.5 text-right font-mono tabular-nums font-semibold ${
                              item.buildable_assemblies === 0 ? 'text-red-700' : 'text-emerald-700'
                            }`}
                          >
                            {item.buildable_assemblies.toLocaleString()}
                          </td>
                          <td className="px-5 py-2.5 text-xs text-slate-500">{item.notes || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))
          )}
        </div>

        {canEdit ? (
          <form
            onSubmit={handleSave}
            className="lg:col-span-5 rounded-xl border border-slate-200 bg-white p-6 space-y-4"
          >
            <h2 className="text-base font-semibold text-slate-900">Create or Update BOM</h2>
            <p className="text-xs text-slate-500">
              Submitting an existing Parent Assembly Part replaces its component list.
            </p>

            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <label htmlFor="bom-parent" className="block text-xs font-medium text-slate-600">
                  Parent Assembly Part
                </label>
                <input
                  id="bom-parent"
                  type="text"
                  value={parentPart}
                  onChange={(e) => setParentPart(e.target.value)}
                  required
                  placeholder="ASM-NEW-01"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                />
              </div>
              <div>
                <label htmlFor="bom-rev" className="block text-xs font-medium text-slate-600">
                  Revision
                </label>
                <input
                  id="bom-rev"
                  type="text"
                  value={revision}
                  onChange={(e) => setRevision(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                />
              </div>
            </div>

            <div>
              <label htmlFor="bom-desc" className="block text-xs font-medium text-slate-600">
                Assembly Description
              </label>
              <input
                id="bom-desc"
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Subassembly description"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
              />
            </div>

            <div className="pt-2 border-t border-slate-100 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-700">Component Lines</span>
                <button
                  type="button"
                  onClick={addLine}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:text-blue-800 whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Component</span>
                </button>
              </div>

              {lines.map((line, idx) => (
                <div key={idx} className="grid grid-cols-12 gap-2 items-center">
                  <input
                    type="text"
                    placeholder="Component PN"
                    value={line.component_part}
                    onChange={(e) =>
                      setLines((prev) =>
                        prev.map((l, i) => (i === idx ? { ...l, component_part: e.target.value } : l))
                      )
                    }
                    required
                    className="col-span-5 rounded-lg border border-slate-300 px-2.5 py-2 text-xs font-mono text-slate-900 focus:border-blue-600 focus:outline-none"
                  />
                  <input
                    type="number"
                    min={1}
                    placeholder="Qty"
                    value={line.qty_per_assembly}
                    onChange={(e) =>
                      setLines((prev) =>
                        prev.map((l, i) => (i === idx ? { ...l, qty_per_assembly: e.target.value } : l))
                      )
                    }
                    required
                    className="col-span-2 rounded-lg border border-slate-300 px-2 py-2 text-xs font-mono tabular-nums text-slate-900 focus:border-blue-600 focus:outline-none"
                  />
                  <input
                    type="text"
                    placeholder="Notes"
                    value={line.notes}
                    onChange={(e) =>
                      setLines((prev) =>
                        prev.map((l, i) => (i === idx ? { ...l, notes: e.target.value } : l))
                      )
                    }
                    className="col-span-4 rounded-lg border border-slate-300 px-2.5 py-2 text-xs text-slate-900 focus:border-blue-600 focus:outline-none"
                  />
                  <button
                    type="button"
                    disabled={lines.length === 1}
                    onClick={() => removeLine(idx)}
                    aria-label="Remove component line"
                    className="col-span-1 flex items-center justify-center p-1.5 text-slate-400 hover:text-red-700 disabled:opacity-30"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>

            <button
              type="submit"
              disabled={saving}
              className="w-full rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              {saving ? 'Saving BOM...' : 'Save BOM Definition'}
            </button>
          </form>
        ) : (
          <div className="lg:col-span-12 rounded-lg border border-slate-200 bg-white px-4 py-3 text-xs text-slate-600">
            Signed in as <span className="font-mono font-semibold">{user.role}</span> — BOM definitions are read-only for operators. Supervisor or Admin role is required to create or modify BOMs.
          </div>
        )}
      </div>
    </div>
  );
}
