import React, { useEffect, useState } from 'react';
import * as XLSX from 'xlsx';
import {
  FileSpreadsheet,
  Upload,
  Trash2,
  ChevronDown,
  ChevronRight,
  Search,
  CheckCircle2,
  AlertTriangle,
  Download,
  ScanBarcode,
  RefreshCw,
  FolderKanban,
  Plus,
  X,
} from 'lucide-react';
import { api } from '../api';
import { exportRowsToCsv } from '../utils/audio';
import {
  DEFAULT_STORE_FILE_GROUPS,
  formatStoreGroupLabel,
  type AuthUser,
  type Company,
  type NavSection,
  type StoreFileGroup,
  type UploadedFileRecord,
} from '../types';

interface UploadedFilesViewProps {
  company: Company;
  companies: Company[];
  user: AuthUser;
  onNavigate: (section: NavSection) => void;
}

interface ParsedUploadRow {
  lookup_key: string;
  part_name: string;
  part_number: string;
  qty: number;
  batch_ref: string;
}

const DEFAULT_GROUPS: readonly string[] = DEFAULT_STORE_FILE_GROUPS;

function getGroupBadgeClass(group: string): string {
  const upper = group.toUpperCase();
  if (upper.includes('B01')) return 'border-blue-200 bg-blue-50 text-blue-800';
  if (upper.includes('SAIC')) return 'border-emerald-200 bg-emerald-50 text-emerald-800';
  if (upper.includes('M81')) return 'border-amber-200 bg-amber-50 text-amber-800';
  if (upper.includes('EC15S')) return 'border-violet-200 bg-violet-50 text-violet-800';
  return 'border-slate-200 bg-slate-100 text-slate-800';
}

export function UploadedFilesView({ company, companies, user, onNavigate }: UploadedFilesViewProps) {
  const [files, setFiles] = useState<UploadedFileRecord[]>([]);
  const [storeGroups, setStoreGroups] = useState<string[]>([...DEFAULT_GROUPS]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [updatingGroupId, setUpdatingGroupId] = useState<number | null>(null);
  const [uploadGroup, setUploadGroup] = useState<StoreFileGroup>('B01');
  const [groupFilter, setGroupFilter] = useState<'all' | StoreFileGroup | 'unassigned'>('all');
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState<'all' | 'current'>('all');
  const [expandedFileId, setExpandedFileId] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [confirmDeleteGroupId, setConfirmDeleteGroupId] = useState<string | null>(null);
  const [showAddGroupModal, setShowAddGroupModal] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const canDelete = user.role === 'admin' || user.role === 'supervisor';
  const isAdmin = user.role === 'admin';

  async function loadFiles() {
    setLoading(true);
    try {
      const [filesRes, groupsRes] = await Promise.all([
        api.getAllUploadedFiles(),
        api.getStoreGroups(),
      ]);
      setFiles(filesRes.files);
      const fetched = groupsRes.map((g) => g.id || g.name);
      const combined = Array.from(new Set([...DEFAULT_GROUPS, ...fetched]));
      setStoreGroups(combined);
      if (filesRes.files.length > 0) {
        setExpandedFileId((prev) =>
          prev !== null && filesRes.files.some((f) => f.id === prev) ? prev : filesRes.files[0].id
        );
      }
    } catch (err) {
      setFeedback({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Failed to load uploaded files.',
      });
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateGroup(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = newGroupName.trim();
    if (!trimmed) return;
    setFeedback(null);
    try {
      const res = await api.createStoreGroup(trimmed);
      const createdId = res.id;
      setStoreGroups((prev) => Array.from(new Set([...prev, createdId])));
      setUploadGroup(createdId);
      setNewGroupName('');
      setShowAddGroupModal(false);
      setFeedback({
        kind: 'success',
        text: `Successfully created store group "${formatStoreGroupLabel(createdId)}".`,
      });
    } catch (err) {
      setFeedback({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Failed to create group.',
      });
    }
  }

  async function handleDeleteCustomGroup(groupId: string) {
    setFeedback(null);
    try {
      await api.deleteStoreGroup(groupId);
      setStoreGroups((prev) => prev.filter((g) => g !== groupId));
      if (uploadGroup === groupId) {
        setUploadGroup('B01');
      }
      if (groupFilter === groupId) {
        setGroupFilter('all');
      }
      setConfirmDeleteGroupId(null);
      setFeedback({
        kind: 'success',
        text: `Removed custom store group "${formatStoreGroupLabel(groupId)}".`,
      });
    } catch (err) {
      setFeedback({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Failed to delete store group.',
      });
    }
  }

  useEffect(() => {
    setConfirmDeleteId(null);
    setConfirmDeleteGroupId(null);
    void loadFiles();
  }, [company.id]);

  function parseMatrixToRows(matrix: unknown[][]): ParsedUploadRow[] {
    const rows: ParsedUploadRow[] = [];
    for (let i = 0; i < matrix.length; i++) {
      const rawRow = matrix[i];
      if (!Array.isArray(rawRow)) continue;

      const lookupKey = String(rawRow[0] ?? '').trim();
      const partName = String(rawRow[1] ?? '').trim();
      const partNumber = String(rawRow[2] ?? '').trim();
      const qtyRaw = String(rawRow[3] ?? '').trim();
      const qtyNumericStr = qtyRaw.replace(/,/g, '');
      const batchRef = String(rawRow[4] ?? '').trim();

      if (!lookupKey && !partNumber) continue;

      const lookupLower = lookupKey.toLowerCase();
      const qtyLower = qtyRaw.toLowerCase();
      const isHeader =
        i === 0 &&
        (['lookup', 'lookup criteria', 'pallet', 'pallet id', 'column a', 'a', 'criteria'].includes(
          lookupLower
        ) ||
          ['qty', 'quantity', 'column d'].includes(qtyLower) ||
          (qtyNumericStr !== '' && !Number.isFinite(Number(qtyNumericStr))));

      if (isHeader) continue;

      const parsedQty = Math.floor(Number(qtyNumericStr));
      if (!lookupKey) continue;

      rows.push({
        lookup_key: lookupKey,
        part_name: partName || 'Part Item',
        part_number: partNumber || lookupKey,
        qty: Number.isInteger(parsedQty) && parsedQty > 0 ? parsedQty : 1,
        batch_ref: batchRef,
      });
    }
    return rows;
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setUploading(true);
    setFeedback(null);

    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const firstSheetName = workbook.SheetNames[0];
      if (!firstSheetName) {
        throw new Error('The uploaded workbook has no sheets.');
      }

      const sheet = workbook.Sheets[firstSheetName];
      const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' });
      const parsedRows = parseMatrixToRows(matrix);

      if (parsedRows.length === 0) {
        throw new Error(
          'No valid data rows found. Ensure Column A = Lookup/Pallet, Column B = Part Name, Column C = Part Number, Column D = Qty, Column E = Batch/Ref.'
        );
      }

      const res = await api.uploadMasterFile({
        company_id: company.id,
        file_name: file.name,
        store_group: uploadGroup,
        rows: parsedRows,
      });

      const groupLabel = formatStoreGroupLabel(uploadGroup);
      setFiles((prev) => [res.file, ...prev]);
      setExpandedFileId(res.file.id);
      setFeedback({
        kind: 'success',
        text: `Saved "${res.file.file_name}" (${res.file.row_count} rows) under group ${groupLabel} permanently in Cloud Firestore.`,
      });
    } catch (err) {
      setFeedback({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Failed to parse or store uploaded file.',
      });
    } finally {
      setUploading(false);
    }
  }

  async function handleLoadSampleFile() {
    setUploading(true);
    setFeedback(null);
    try {
      const sampleRows: ParsedUploadRow[] = [
        {
          lookup_key: 'EC15S6006-401F2703',
          part_name: 'Bracket Assembly Front',
          part_number: '5306NW610001AC01',
          qty: 10,
          batch_ref: 'EC15S6006-4',
        },
        {
          lookup_key: 'EC15S6006-401F2703',
          part_name: 'Stainless Reinforcement',
          part_number: '5306NW610002AC01',
          qty: 20,
          batch_ref: 'EC15S6006-4',
        },
        {
          lookup_key: 'EC15S6006-401F2703',
          part_name: 'Copper Thermal Bushing',
          part_number: '5306NW610003AC01',
          qty: 30,
          batch_ref: 'EC15S6006-4',
        },
      ];

      const res = await api.uploadMasterFile({
        company_id: company.id,
        file_name: `sample-pallet-${uploadGroup.toLowerCase()}-${company.code.toLowerCase()}.xlsx`,
        store_group: uploadGroup,
        rows: sampleRows,
      });

      const groupLabel = formatStoreGroupLabel(uploadGroup);
      setFiles((prev) => [res.file, ...prev]);
      setExpandedFileId(res.file.id);
      setFeedback({
        kind: 'success',
        text: `Stored sample 3-item pallet file "${res.file.file_name}" under group ${groupLabel} permanently in Cloud Firestore.`,
      });
    } catch (err) {
      setFeedback({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Failed to create sample file.',
      });
    } finally {
      setUploading(false);
    }
  }

  async function handleChangeFileGroup(fileId: number, nextGroup: StoreFileGroup | '') {
    setUpdatingGroupId(fileId);
    setFeedback(null);
    try {
      const res = await api.updateUploadedFileGroup(fileId, nextGroup);
      setFiles((prev) =>
        prev.map((f) => (f.id === fileId ? { ...f, store_group: res.store_group } : f))
      );
      const label = res.store_group ? formatStoreGroupLabel(res.store_group) : 'Unassigned';
      setFeedback({
        kind: 'success',
        text: `Updated file group to ${label} in Cloud Firestore.`,
      });
    } catch (err) {
      setFeedback({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Failed to update store file group.',
      });
    } finally {
      setUpdatingGroupId(null);
    }
  }

  async function handleDeleteFile(fileId: number) {
    setFeedback(null);
    try {
      await api.deleteUploadedFile(fileId);
      setFiles((prev) => prev.filter((f) => f.id !== fileId));
      if (expandedFileId === fileId) {
        setExpandedFileId(null);
      }
      setConfirmDeleteId(null);
      setFeedback({ kind: 'success', text: 'Uploaded file deleted from Cloud Firestore.' });
    } catch (err) {
      setFeedback({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Failed to delete file.',
      });
    }
  }

  function handleDownloadTemplate() {
    exportRowsToCsv(
      'pallet-packing-list-template.csv',
      ['Lookup Criteria (Col A)', 'Part Name (Col B)', 'Part Number (Col C)', 'Qty (Col D)', 'Batch / Ref (Col E)'],
      [
        ['EC15S6006-401F2703', 'Bracket Assembly Front', '5306NW610001AC01', 10, 'EC15S6006-4'],
        ['EC15S6006-401F2703', 'Stainless Reinforcement', '5306NW610002AC01', 20, 'EC15S6006-4'],
        ['EC15S6006-401F2703', 'Copper Thermal Bushing', '5306NW610003AC01', 30, 'EC15S6006-4'],
      ]
    );
  }

  function handleExportStoredFile(file: UploadedFileRecord) {
    const baseName = file.file_name.replace(/\.[^/.]+$/, '');
    exportRowsToCsv(
      `${baseName}.csv`,
      ['Lookup Criteria (Col A)', 'Part Name (Col B)', 'Part Number (Col C)', 'Qty (Col D)', 'Batch / Ref (Col E)'],
      file.rows.map((r) => [r.lookup_key, r.part_name, r.part_number, r.qty, r.batch_ref || ''])
    );
  }

  function getCompanyLabel(companyId: number): string {
    return companies.find((c) => c.id === companyId)?.code || `COMP-${companyId}`;
  }

  const scopedFiles = scope === 'current' ? files.filter((f) => f.company_id === company.id) : files;

  const groupScopedFiles = scopedFiles.filter((f) => {
    const fg = f.store_group || '';
    if (groupFilter === 'all') return true;
    if (groupFilter === 'unassigned') return fg === '';
    return fg === groupFilter;
  });

  const normalizedSearch = search.trim().toLowerCase();
  const filteredFiles = normalizedSearch
    ? groupScopedFiles.filter(
        (f) =>
          f.file_name.toLowerCase().includes(normalizedSearch) ||
          (f.store_group || '').toLowerCase().includes(normalizedSearch) ||
          f.rows.some(
            (r) =>
              r.lookup_key.toLowerCase().includes(normalizedSearch) ||
              r.part_name.toLowerCase().includes(normalizedSearch) ||
              r.part_number.toLowerCase().includes(normalizedSearch) ||
              r.batch_ref.toLowerCase().includes(normalizedSearch)
          )
      )
    : groupScopedFiles;

  const unassignedCount = scopedFiles.filter((f) => !f.store_group).length;
  const totalStoredRows = scopedFiles.reduce((sum, f) => sum + (f.rows.length || f.row_count), 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Uploaded File</h1>
          <p className="mt-1 text-sm text-slate-600">
            Persistent Cloud Repository ·{' '}
            <span className="font-mono tabular-nums">{scopedFiles.length}</span> stored file(s) ·{' '}
            <span className="font-mono tabular-nums">{totalStoredRows}</span> lookup row(s)
          </p>
        </div>

        <div className="flex items-center gap-2.5 flex-wrap shrink-0">
          <button
            type="button"
            onClick={() => void loadFiles()}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
          >
            <RefreshCw className={`w-4 h-4 text-slate-600 ${loading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
          <button
            type="button"
            onClick={handleDownloadTemplate}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
          >
            <Download className="w-4 h-4 text-slate-600" />
            <span>CSV Template</span>
          </button>
          <button
            type="button"
            onClick={() => onNavigate('receiving')}
            className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3.5 py-2 text-sm font-semibold text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            <ScanBarcode className="w-4 h-4" />
            <span>Open Container Receiving</span>
          </button>
        </div>
      </div>

      {/* Upload Dropzone / Action Card */}
      <div className="rounded-xl border border-slate-200 bg-white p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <FileSpreadsheet className="w-5 h-5 text-blue-700 shrink-0" />
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Upload Packing List (Excel / CSV)
              </h2>
              <p className="text-xs text-slate-600 mt-0.5">
                Files uploaded here are saved permanently in Cloud Firestore under{' '}
                <span className="font-semibold">{company.code}</span> and preserved across all system updates.
              </p>
            </div>
          </div>

          <button
            type="button"
            disabled={uploading}
            onClick={() => void handleLoadSampleFile()}
            className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
          >
            Load Sample 3-Item Pallet File
          </button>
        </div>

        <div className="rounded-lg bg-slate-50 border border-slate-200 p-3.5 text-xs text-slate-700 grid grid-cols-2 sm:grid-cols-5 gap-2 font-mono">
          <div>
            <span className="text-slate-500 block font-sans">Column A</span>
            <span className="font-semibold text-slate-900">Lookup / Pallet Key</span>
          </div>
          <div>
            <span className="text-slate-500 block font-sans">Column B</span>
            <span className="font-semibold text-slate-900">Part Name</span>
          </div>
          <div>
            <span className="text-slate-500 block font-sans">Column C</span>
            <span className="font-semibold text-slate-900">Part Number</span>
          </div>
          <div>
            <span className="text-slate-500 block font-sans">Column D</span>
            <span className="font-semibold text-slate-900">Qty (Integer)</span>
          </div>
          <div>
            <span className="text-slate-500 block font-sans">Column E</span>
            <span className="font-semibold text-slate-900">Batch / Ref</span>
          </div>
        </div>

        {/* Store File Grouping Selection */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 pt-1">
          <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700 shrink-0">
            <FolderKanban className="w-4 h-4 text-blue-700" />
            <span>Store File Group:</span>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {storeGroups.map((g) => {
              const selected = uploadGroup === g;
              const isCustom = !DEFAULT_GROUPS.includes(g);
              const isConfirming = confirmDeleteGroupId === g;

              if (isConfirming) {
                return (
                  <div
                    key={g}
                    className="inline-flex items-center gap-1 rounded-lg border border-red-300 bg-red-50 px-2 py-1 text-xs"
                  >
                    <span className="font-mono text-red-900 font-semibold">Delete {formatStoreGroupLabel(g)}?</span>
                    <button
                      type="button"
                      onClick={() => void handleDeleteCustomGroup(g)}
                      className="px-1.5 py-0.5 rounded bg-red-700 text-white font-medium hover:bg-red-800 transition-colors"
                    >
                      Yes
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteGroupId(null)}
                      className="px-1.5 py-0.5 rounded bg-white text-slate-700 border border-slate-300 hover:bg-slate-100 transition-colors"
                    >
                      No
                    </button>
                  </div>
                );
              }

              return (
                <div key={g} className="inline-flex items-center">
                  <button
                    type="button"
                    onClick={() => setUploadGroup(g)}
                    className={`rounded-lg border px-3 py-1.5 text-xs font-mono font-semibold transition-colors whitespace-nowrap ${
                      selected
                        ? 'border-slate-900 bg-slate-900 text-white shadow-xs'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    {formatStoreGroupLabel(g)}
                  </button>
                  {isAdmin && isCustom && (
                    <button
                      type="button"
                      title={`Remove custom group ${formatStoreGroupLabel(g)}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDeleteGroupId(g);
                      }}
                      className="ml-0.5 p-1 text-slate-400 hover:text-red-600 rounded transition-colors"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              );
            })}
            {isAdmin && (
              <button
                type="button"
                onClick={() => {
                  setNewGroupName('');
                  setShowAddGroupModal(true);
                }}
                className="inline-flex items-center gap-1 rounded-lg border border-dashed border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-50/60 transition-colors whitespace-nowrap"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Group</span>
              </button>
            )}
          </div>
        </div>

        {/* Add Group Modal / Inline Form */}
        {showAddGroupModal && (
          <form onSubmit={handleCreateGroup} className="rounded-xl border border-blue-200 bg-blue-50/70 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-900">Add New Store File Group</div>
              <button
                type="button"
                onClick={() => setShowAddGroupModal(false)}
                className="text-slate-400 hover:text-slate-700"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex gap-2.5">
              <input
                type="text"
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                placeholder="Enter group name (e.g. 5-LINE-A or WH-01)"
                autoFocus
                className="flex-1 rounded-lg border border-blue-300 bg-white px-3 py-2 text-sm font-mono text-slate-900 focus:border-blue-600 focus:outline-none"
              />
              <button
                type="submit"
                disabled={!newGroupName.trim()}
                className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-50 whitespace-nowrap"
              >
                Create Group
              </button>
            </div>
          </form>
        )}

        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <label className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-800 cursor-pointer transition-colors whitespace-nowrap">
            <Upload className="w-4 h-4" />
            <span>
              {uploading ? 'Saving File...' : `Upload Excel / CSV to ${formatStoreGroupLabel(uploadGroup)}`}
            </span>
            <input
              type="file"
              accept=".xlsx,.xls,.csv,.tsv,.txt"
              disabled={uploading}
              onChange={(e) => void handleFileSelect(e)}
              className="sr-only"
            />
          </label>
          <span className="text-xs text-slate-500">
            Multiple rows sharing the same Column A key (e.g. 3 parts on one pallet) will all load when scanned.
          </span>
        </div>

        {feedback && (
          <div
            role="status"
            className={`rounded-lg border px-4 py-3 text-sm flex items-start gap-2.5 ${
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
      </div>

      {/* Stored Files Repository */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 space-y-3">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <div className="flex items-center gap-3 flex-wrap">
              <h2 className="text-base font-semibold text-slate-900">
                Stored Files ({filteredFiles.length})
              </h2>
              <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
                <button
                  type="button"
                  onClick={() => setScope('all')}
                  className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                    scope === 'all' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  All Companies ({files.length})
                </button>
                <button
                  type="button"
                  onClick={() => setScope('current')}
                  className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                    scope === 'current' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {company.code} ({files.filter((f) => f.company_id === company.id).length})
                </button>
              </div>
            </div>

            <div className="relative w-full md:w-72">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search filename, lookup key, part..."
                className="w-full rounded-lg border border-slate-300 pl-9 pr-3 py-1.5 text-sm text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
              />
            </div>
          </div>

          {/* Store File Group Tabs */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs font-medium text-slate-500 mr-1">Group Filter:</span>
            <button
              type="button"
              onClick={() => setGroupFilter('all')}
              className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors whitespace-nowrap ${
                groupFilter === 'all'
                  ? 'bg-slate-900 text-white'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200/70'
              }`}
            >
              All Groups ({scopedFiles.length})
            </button>
            {storeGroups.map((g) => {
              const count = scopedFiles.filter((f) => f.store_group === g).length;
              const active = groupFilter === g;
              return (
                <button
                  key={g}
                  type="button"
                  onClick={() => setGroupFilter(g)}
                  className={`rounded-md px-2.5 py-1 text-xs font-mono font-semibold transition-colors whitespace-nowrap ${
                    active
                      ? 'bg-blue-700 text-white'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200/70'
                  }`}
                >
                  {formatStoreGroupLabel(g)} ({count})
                </button>
              );
            })}
            {unassignedCount > 0 && (
              <button
                type="button"
                onClick={() => setGroupFilter('unassigned')}
                className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors whitespace-nowrap ${
                  groupFilter === 'unassigned'
                    ? 'bg-slate-700 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200/70'
                }`}
              >
                Unassigned ({unassignedCount})
              </button>
            )}
          </div>
        </div>

        {loading ? (
          <div className="p-8 text-center text-sm text-slate-500">Loading stored files from Firestore...</div>
        ) : filteredFiles.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-500">
            No uploaded files match this group or search filter yet. Upload an Excel/CSV file above or switch groups.
          </div>
        ) : (
          <div className="divide-y divide-slate-200">
            {filteredFiles.map((file) => {
              const isExpanded = expandedFileId === file.id;
              const distinctKeys = new Set(file.rows.map((r) => r.lookup_key.toUpperCase())).size;

              return (
                <div key={file.id} className="bg-white">
                  <div className="px-5 py-3.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 hover:bg-slate-50/70 transition-colors">
                    <button
                      type="button"
                      onClick={() => setExpandedFileId(isExpanded ? null : file.id)}
                      className="flex items-center gap-3 text-left min-w-0 flex-1"
                    >
                      {isExpanded ? (
                        <ChevronDown className="w-4 h-4 text-slate-500 shrink-0" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-slate-500 shrink-0" />
                      )}
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-sm font-semibold text-slate-900 truncate">
                            {file.file_name}
                          </span>
                          <span className="font-mono text-[11px] font-medium text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded">
                            {getCompanyLabel(file.company_id)}
                          </span>
                          {file.store_group ? (
                            <span
                              className={`font-mono text-[11px] font-semibold border px-1.5 py-0.5 rounded ${getGroupBadgeClass(file.store_group)}`}
                            >
                              {formatStoreGroupLabel(file.store_group)}
                            </span>
                          ) : (
                            <span className="text-[11px] font-medium text-slate-500 border border-slate-200 bg-slate-50 px-1.5 py-0.5 rounded">
                              Unassigned
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5">
                          <span className="font-mono tabular-nums">{file.rows.length || file.row_count}</span> rows ·{' '}
                          <span className="font-mono tabular-nums">{distinctKeys}</span> lookup key(s) · uploaded by{' '}
                          {file.uploaded_by} · {new Date(file.uploaded_at).toLocaleString()}
                        </div>
                      </div>
                    </button>

                    <div className="flex items-center gap-2 shrink-0 self-end sm:self-auto flex-wrap">
                      <select
                        aria-label={`Assign store group for ${file.file_name}`}
                        disabled={updatingGroupId === file.id}
                        value={file.store_group || ''}
                        onChange={(e) =>
                          void handleChangeFileGroup(file.id, e.target.value as StoreFileGroup | '')
                        }
                        className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-mono font-medium text-slate-700 hover:border-slate-300 focus:border-blue-600 focus:outline-none disabled:opacity-50"
                      >
                        <option value="">No Group</option>
                        {storeGroups.map((g) => (
                          <option key={g} value={g}>
                            {formatStoreGroupLabel(g)}
                          </option>
                        ))}
                      </select>

                      <button
                        type="button"
                        onClick={() => handleExportStoredFile(file)}
                        className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                      >
                        Export CSV
                      </button>

                      <button
                        type="button"
                        onClick={() => setExpandedFileId(isExpanded ? null : file.id)}
                        className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                      >
                        {isExpanded ? 'Hide Rows' : 'View Rows'}
                      </button>

                      {canDelete &&
                        (confirmDeleteId === file.id ? (
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(null)}
                              className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 whitespace-nowrap"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleDeleteFile(file.id)}
                              className="rounded-md bg-red-700 px-2.5 py-1 text-xs font-semibold text-white hover:bg-red-800 whitespace-nowrap"
                            >
                              Confirm Delete
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(file.id)}
                            aria-label={`Delete ${file.file_name}`}
                            className="inline-flex items-center justify-center rounded-md p-1.5 text-slate-400 hover:text-red-700 hover:bg-red-50 transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        ))}
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="border-t border-slate-100 bg-slate-50/40 overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-medium text-slate-500">
                            <th className="px-5 py-2">#</th>
                            <th className="px-4 py-2">Col A: Lookup / Pallet Key</th>
                            <th className="px-4 py-2">Col B: Part Name</th>
                            <th className="px-4 py-2">Col C: Part Number</th>
                            <th className="px-4 py-2 text-right">Col D: Qty</th>
                            <th className="px-5 py-2">Col E: Batch / Ref</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 bg-white">
                          {file.rows.map((row, idx) => (
                            <tr key={row.id} className="hover:bg-slate-50/70">
                              <td className="px-5 py-2 font-mono tabular-nums text-xs text-slate-500">
                                {idx + 1}
                              </td>
                              <td className="px-4 py-2 font-mono font-medium text-slate-900">
                                {row.lookup_key}
                              </td>
                              <td className="px-4 py-2 text-slate-700">{row.part_name}</td>
                              <td className="px-4 py-2 font-mono text-slate-900">{row.part_number}</td>
                              <td className="px-4 py-2 text-right font-mono tabular-nums font-semibold text-slate-900">
                                {row.qty.toLocaleString()}
                              </td>
                              <td className="px-5 py-2 font-mono text-xs text-slate-600">
                                {row.batch_ref || '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
