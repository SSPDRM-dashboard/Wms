import React, { useEffect, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import {
  ScanBarcode,
  Volume2,
  VolumeX,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  Info,
  PackageCheck,
  ClipboardCheck,
  X,
  ArrowLeft,
  MapPin,
  Upload,
  FileSpreadsheet,
  Layers,
  Box,
} from 'lucide-react';
import { api } from '../api';
import { playScanFeedback } from '../utils/audio';
import {
  DEFAULT_STORE_FILE_GROUPS,
  formatStoreGroupLabel,
  type Company,
  type ContainerRecord,
  type NavSection,
  type ParsedQrResult,
  type PendingScanItem,
  type StoreFileGroup,
  type UploadedFileRecord,
} from '../types';

interface ReceivingViewProps {
  company: Company;
  pendingScans: PendingScanItem[];
  onPendingScansChange: React.Dispatch<React.SetStateAction<PendingScanItem[]>>;
  onNavigate?: (section: NavSection) => void;
}

export function ReceivingView({
  company,
  pendingScans = [],
  onPendingScansChange,
  onNavigate,
}: ReceivingViewProps) {
  const scanInputRef = useRef<HTMLInputElement>(null);
  const addressInputRef = useRef<HTMLInputElement>(null);

  const [containerCode, setContainerCode] = useState(
    () => `CONT-${company.id === 1 ? 'A' : 'B'}-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-01`
  );
  const [location, setLocation] = useState(company.id === 1 ? 'RCV-DOCK-01' : 'RCV-DOCK-02');
  const [palletRef, setPalletRef] = useState('');
  const [scanMode, setScanMode] = useState<'box' | 'pallet'>('box');
  const [addressMode, setAddressMode] = useState<'container' | 'scan_after_box'>('container');
  const [rawScan, setRawScan] = useState('');
  const [addressScan, setAddressScan] = useState('');
  const [awaitingAddressItems, setAwaitingAddressItems] = useState<
    Array<Omit<PendingScanItem, 'location'>>
  >([]);
  const [muted, setMuted] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [lastParse, setLastParse] = useState<ParsedQrResult | null>(null);
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'warning' | 'error'; text: string } | null>(null);
  const [containers, setContainers] = useState<ContainerRecord[]>([]);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFileRecord[]>([]);
  const [storeGroups, setStoreGroups] = useState<string[]>([...DEFAULT_STORE_FILE_GROUPS]);
  const [lookupGroup, setLookupGroup] = useState<'all' | StoreFileGroup>('all');
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  const isAwaitingAddress = awaitingAddressItems.length > 0;

  async function loadUploadedFiles() {
    try {
      const [filesRes, groupsRes] = await Promise.all([
        api.getAllUploadedFiles(),
        api.getStoreGroups(),
      ]);
      setUploadedFiles(filesRes.files);
      const fetched = groupsRes.map((g) => g.id || g.name);
      const combined = Array.from(new Set([...DEFAULT_STORE_FILE_GROUPS, ...fetched]));
      setStoreGroups(combined);
    } catch (err) {
      setFeedback({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Unable to load Uploaded File records from Firestore.',
      });
    }
  }

  function focusActiveScanner() {
    if (reviewOpen) return;
    requestAnimationFrame(() => {
      if (addressMode === 'scan_after_box' && awaitingAddressItems.length > 0) {
        addressInputRef.current?.focus();
      } else {
        scanInputRef.current?.focus();
      }
    });
  }

  useEffect(() => {
    setLocation(company.id === 1 ? 'RCV-DOCK-01' : 'RCV-DOCK-02');
    setContainerCode(`CONT-${company.id === 1 ? 'A' : 'B'}-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-01`);
    setPalletRef('');
    setLastParse(null);
    setFeedback(null);
    setAwaitingAddressItems([]);
    setAddressScan('');
    setReviewOpen(false);
    setReviewError(null);
    void loadContainers();
    void loadUploadedFiles();
  }, [company.id]);

  useEffect(() => {
    if (reviewOpen || parsing) return;
    const frameId = requestAnimationFrame(() => {
      if (addressMode === 'scan_after_box' && awaitingAddressItems.length > 0) {
        addressInputRef.current?.focus();
      } else {
        scanInputRef.current?.focus();
      }
    });
    return () => cancelAnimationFrame(frameId);
  }, [company.id, addressMode, awaitingAddressItems, parsing, reviewOpen]);

  useEffect(() => {
    if (!reviewOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !committing) {
        setReviewOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [reviewOpen, committing]);

  async function loadContainers() {
    try {
      const res = await api.getContainers(company.id);
      setContainers(res.containers);
    } catch {
      // Non-blocking
    }
  }

  function stageMasterLookupItems(
    trimmed: string,
    matchedKey: string,
    fileName: string | null,
    items: Array<{ part_name: string; part_number: string; qty: number; batch_ref: string }>
  ) {
    const activePalletKey = matchedKey || trimmed;
    setPalletRef(activePalletKey);

    const drafts: Array<Omit<PendingScanItem, 'location'>> = items.map((row, idx) => ({
      localId: `${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 7)}`,
      partNumber: row.part_number,
      qty: row.qty,
      boxId:
        items.length > 1
          ? `${activePalletKey}-${String(idx + 1).padStart(2, '0')}`
          : activePalletKey,
      batchRef: row.batch_ref || '',
      palletRef: activePalletKey,
      rawScan: trimmed,
      scannedAt: new Date().toISOString(),
    }));

    const duplicate = drafts.find((draft) => {
      const is60Batch = String(draft.batchRef || '').toLowerCase().includes('60');
      if (is60Batch) return false;
      return pendingScans.some((p) => p.boxId.toLowerCase() === draft.boxId.toLowerCase());
    });

    if (duplicate) {
      playScanFeedback('error', muted);
      setFeedback({
        kind: 'error',
        text: `Duplicate pallet/box scan blocked: "${duplicate.boxId}" is already staged in Pending Container Scans.`,
      });
      setRawScan('');
      return;
    }

    if (addressMode === 'scan_after_box') {
      playScanFeedback('pallet', muted);
      setAwaitingAddressItems(drafts);
      setAddressScan('');
      setRawScan('');
      setFeedback({
        kind: 'warning',
        text: `Pallet "${activePalletKey}" matched ${drafts.length} item(s) from "${
          fileName || 'Uploaded File'
        }". Now scan warehouse address / bin barcode to assign all ${drafts.length} item(s).`,
      });
      return;
    }

    const targetLoc = location.trim() || 'RCV-DOCK-01';
    const newItems: PendingScanItem[] = drafts.map((d) => ({
      ...d,
      location: targetLoc,
    }));
    const totalUnits = newItems.reduce((sum, it) => sum + it.qty, 0);

    playScanFeedback('success', muted);
    onPendingScansChange((prev) => [...newItems, ...prev]);
    setFeedback({
      kind: 'success',
      text: `Loaded Pallet "${activePalletKey}" from "${fileName || 'Uploaded File'}": ${
        newItems.length
      } item(s) (${totalUnits.toLocaleString()} units) added to Pending Container Scans @ ${targetLoc}.`,
    });
    setRawScan('');
  }

  async function processScan(inputStr: string) {
    const trimmed = inputStr.trim();
    if (!trimmed) return;
    setParsing(true);
    setFeedback(null);

    try {
      if (scanMode === 'pallet') {
        const activeGroup = lookupGroup === 'all' ? '' : lookupGroup;
        const lookupRes = await api.lookupUploadedReceiving(company.id, trimmed, activeGroup);
        setLastParse(null);

        if (!lookupRes.matched || lookupRes.items.length === 0) {
          playScanFeedback('error', muted);
          setFeedback({
            kind: 'error',
            text: `Pallet "${trimmed}" was not found in Uploaded File records${
              lookupGroup !== 'all' ? ` for group ${formatStoreGroupLabel(lookupGroup)}` : ''
            }. Upload the Excel/CSV packing list in the "Uploaded File" page or switch Pallet Lookup Group.`,
          });
          setRawScan('');
          return;
        }

        stageMasterLookupItems(
          trimmed,
          lookupRes.matchedKey || trimmed,
          lookupRes.fileName,
          lookupRes.items
        );
        return;
      }

      // Scan by Box mode
      const result = await api.parseScan(company.id, trimmed);
      setLastParse(result);

      if (!result.valid) {
        // Fallback: check Uploaded File repository if the scanned code matches a stored Col A key
        const activeGroup = lookupGroup === 'all' ? '' : lookupGroup;
        const lookupRes = await api.lookupUploadedReceiving(company.id, trimmed, activeGroup);
        if (lookupRes.matched && lookupRes.items.length > 0) {
          stageMasterLookupItems(
            trimmed,
            lookupRes.matchedKey || trimmed,
            lookupRes.fileName,
            lookupRes.items
          );
          return;
        }

        playScanFeedback('error', muted);
        setFeedback({ kind: 'error', text: result.message });
        setRawScan('');
        return;
      }

      if (result.kind === 'pallet_reference') {
        playScanFeedback('pallet', muted);
        setPalletRef(result.palletRef || '');
        setFeedback({
          kind: 'warning',
          text: `${result.message} Active Pallet Reference set to ${result.palletRef}.`,
        });
        setRawScan('');
        return;
      }

      if (result.kind === 'packing_list' && result.items && result.items.length > 0) {
        const drafts: Array<Omit<PendingScanItem, 'location'>> = result.items.map((it, idx) => ({
          localId: `${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 7)}`,
          partNumber: it.partNumber,
          qty: it.qty,
          boxId: it.boxId,
          batchRef: it.batchRef || '',
          palletRef: palletRef.trim(),
          rawScan: result.cleanedInput,
          scannedAt: new Date().toISOString(),
        }));

        if (addressMode === 'scan_after_box') {
          playScanFeedback('pallet', muted);
          setAwaitingAddressItems(drafts);
          setAddressScan('');
          setRawScan('');
          setFeedback({
            kind: 'warning',
            text: `Packing list (${drafts.length} parts) scanned. Now scan the warehouse address / bin barcode.`,
          });
          return;
        }

        playScanFeedback('success', muted);
        const targetLoc = location.trim() || 'RCV-DOCK-01';
        const newItems: PendingScanItem[] = drafts.map((d) => ({ ...d, location: targetLoc }));
        onPendingScansChange((prev) => [...newItems, ...prev]);
        setFeedback({
          kind: 'success',
          text: `Staged packing list: ${newItems.length} different parts (${newItems.reduce((s, i) => s + i.qty, 0)} total units) added to container.`,
        });
        setRawScan('');
        return;
      }

      // Check duplicate box ID in current pending list (exempt for 60-batches where box numbers can be the same)
      const is60Batch = String(result.batchRef || '').toLowerCase().includes('60');
      const duplicate = is60Batch
        ? null
        : pendingScans.find(
            (item) => item.boxId.toLowerCase() === String(result.boxId).toLowerCase()
          );
      if (duplicate) {
        playScanFeedback('error', muted);
        setFeedback({
          kind: 'error',
          text: `Duplicate box scan blocked: Box "${result.boxId}" is already staged in this container.`,
        });
        setRawScan('');
        return;
      }

      const stagedDraft: Omit<PendingScanItem, 'location'> = {
        localId: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        partNumber: result.partNumber!,
        qty: result.qty!,
        boxId: result.boxId!,
        batchRef: result.batchRef || '',
        palletRef: palletRef.trim(),
        rawScan: result.cleanedInput,
        scannedAt: new Date().toISOString(),
      };

      if (addressMode === 'scan_after_box') {
        playScanFeedback('pallet', muted);
        setAwaitingAddressItems([stagedDraft]);
        setAddressScan('');
        setRawScan('');
        setFeedback({
          kind: 'warning',
          text: `Box ${stagedDraft.boxId} (${stagedDraft.qty} x ${stagedDraft.partNumber}) scanned. Now scan the warehouse address / bin barcode.`,
        });
        return;
      }

      playScanFeedback('success', muted);
      const newItem: PendingScanItem = {
        ...stagedDraft,
        location: location.trim() || 'RCV-DOCK-01',
      };

      onPendingScansChange((prev) => [newItem, ...prev]);
      setFeedback({
        kind: 'success',
        text: `Staged ${newItem.boxId} · ${newItem.qty} units of ${newItem.partNumber} @ ${newItem.location}`,
      });
      setRawScan('');
    } catch (err) {
      playScanFeedback('error', muted);
      setFeedback({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Scan parse error.',
      });
      setRawScan('');
    } finally {
      setParsing(false);
    }
  }

  function commitAddressScan(rawAddressInput: string) {
    if (awaitingAddressItems.length === 0) return;
    // Strip optional scanner AIM prefix (e.g. ]C1, ]Q1) and optional LOC:/ADDR:/BIN: prefix
    const cleaned = rawAddressInput
      .replace(/[\r\n]+/g, '')
      .trim()
      .replace(/^\]([A-Za-z][0-9A-Za-z])/, '')
      .replace(/^(LOC|ADDR|ADDRESS|BIN)\s*[:=\-]\s*/i, '')
      .trim();

    if (!cleaned) {
      playScanFeedback('error', muted);
      setFeedback({ kind: 'error', text: 'Address / bin scan cannot be empty.' });
      setAddressScan('');
      requestAnimationFrame(() => addressInputRef.current?.focus());
      return;
    }

    const newItems: PendingScanItem[] = awaitingAddressItems.map((draft) => ({
      ...draft,
      location: cleaned,
    }));

    playScanFeedback('success', muted);
    onPendingScansChange((prev) => [...newItems, ...prev]);
    setAwaitingAddressItems([]);
    setAddressScan('');

    if (newItems.length === 1) {
      const one = newItems[0];
      setFeedback({
        kind: 'success',
        text: `Staged ${one.boxId} · ${one.qty} units of ${one.partNumber} → Address ${one.location}`,
      });
    } else {
      const totalUnits = newItems.reduce((sum, it) => sum + it.qty, 0);
      setFeedback({
        kind: 'success',
        text: `Staged ${newItems.length} pallet items (${totalUnits.toLocaleString()} units) → Address ${cleaned}`,
      });
    }
  }

  function handleAddressSubmit(e: React.FormEvent) {
    e.preventDefault();
    commitAddressScan(addressScan);
  }

  function handleFormSubmit(e: React.FormEvent) {
    e.preventDefault();
    void processScan(rawScan);
  }

  async function handleCompleteContainer() {
    if (pendingScans.length === 0) return;
    if (!containerCode.trim()) {
      setReviewError('Container / Manifest ID is required before submitting.');
      return;
    }

    setCommitting(true);
    setReviewError(null);
    setFeedback(null);
    try {
      const res = await api.completeContainer({
        company_id: company.id,
        container_code: containerCode.trim(),
        pallet_ref: palletRef.trim(),
        location: location.trim() || 'RCV-DOCK-01',
        items: pendingScans.map((s) => ({
          partNumber: s.partNumber,
          qty: s.qty,
          boxId: s.boxId,
          batchRef: s.batchRef,
          palletRef: s.palletRef || palletRef.trim(),
          location: s.location || location.trim() || 'RCV-DOCK-01',
        })),
      });

      playScanFeedback('success', muted);
      onPendingScansChange([]);
      setPalletRef('');
      setReviewOpen(false);
      setFeedback({
        kind: 'success',
        text: `Container ${res.containerCode} stored in system: ${res.totalBoxes} boxes (${res.totalUnits} units) committed to ${res.location}.`,
      });
      await loadContainers();
    } catch (err) {
      playScanFeedback('error', muted);
      const msg = err instanceof Error ? err.message : 'Failed to store container.';
      setReviewError(msg);
      setFeedback({ kind: 'error', text: msg });
    } finally {
      setCommitting(false);
    }
  }

  const totalPendingUnits = pendingScans.reduce((sum, item) => sum + item.qty, 0);

  const groupedBySku = Object.values(
    pendingScans.reduce<Record<string, { partNumber: string; boxes: number; totalQty: number }>>((acc, item) => {
      if (!acc[item.partNumber]) {
        acc[item.partNumber] = { partNumber: item.partNumber, boxes: 0, totalQty: 0 };
      }
      acc[item.partNumber].boxes += 1;
      acc[item.partNumber].totalQty += item.qty;
      return acc;
    }, {})
  ).sort((a, b) => a.partNumber.localeCompare(b.partNumber));

  const activeGroupFiles =
    lookupGroup === 'all'
      ? uploadedFiles
      : uploadedFiles.filter((f) => (f.store_group || '') === lookupGroup);
  const totalUploadedRows = activeGroupFiles.reduce((sum, f) => sum + f.row_count, 0);

  const palletSampleScans = [
    {
      label: 'Sample Pallet (BUFAJIAN7003/BANII/EC15S6006-401F2703)',
      value: 'BUFAJIAN7003/BANII/EC15S6006-401F2703',
    },
    {
      label: 'Direct Key (EC15S6006-401F2703)',
      value: 'EC15S6006-401F2703',
    },
  ];

  const boxSampleScans =
    company.id === 1
      ? [
          {
            label: 'Sample Box A1',
            value: `CA_PN-4402-AL_STD_120_BOX-A${String(Math.floor(400 + Math.random() * 500))}_LOT-2611A`,
          },
          {
            label: 'Sample Box A2 (AIM ]Q1)',
            value: `]Q1CA_PN-7710-SS_HVY_80_BOX-A${String(Math.floor(400 + Math.random() * 500))}_LOT-2611B`,
          },
        ]
      : [
          {
            label: 'Pallet Ref QR (No Stock)',
            value: `PLT/PAL-2026-${String(Math.floor(100 + Math.random() * 899))}/BAY-04`,
          },
          {
            label: 'Sample Box B1',
            value: `BOX/BR-9081-TI&60/BATCH-26B9/BX-${String(Math.floor(3000 + Math.random() * 6000))}`,
          },
          {
            label: 'Sample Box B2',
            value: `BOX/BR-5520-EL&100/BATCH-26B9/BX-${String(Math.floor(3000 + Math.random() * 6000))}`,
          },
        ];

  const activeSamples = scanMode === 'pallet' ? palletSampleScans : boxSampleScans;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Container Receiving &amp; Bluetooth HID Scanner
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            {company.name} · Scan all boxes, then open the review window to verify and submit.
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            setMuted((m) => !m);
            focusActiveScanner();
          }}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
        >
          {muted ? <VolumeX className="w-4 h-4 text-slate-400" /> : <Volume2 className="w-4 h-4 text-blue-700" />}
          <span>{muted ? 'Scanner Audio Muted' : 'Scanner Audio On'}</span>
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-7 space-y-6">
          {/* Uploaded File Reference Bar */}
          <div className="rounded-xl border border-slate-200 bg-white px-5 py-4 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="flex items-start gap-3 min-w-0">
                <FileSpreadsheet className="w-4 h-4 text-blue-700 mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-slate-900">
                    Uploaded File Reference ({activeGroupFiles.length} file{activeGroupFiles.length === 1 ? '' : 's'} ·{' '}
                    <span className="font-mono tabular-nums">{totalUploadedRows}</span> rows)
                  </div>
                  <p className="text-xs text-slate-600 mt-0.5 truncate">
                    {activeGroupFiles.length > 0
                      ? `Latest: ${activeGroupFiles[0].file_name}${
                          activeGroupFiles[0].store_group
                            ? ` [${formatStoreGroupLabel(activeGroupFiles[0].store_group)}]`
                            : ''
                        } · Stored permanently in Firestore.`
                      : lookupGroup === 'all'
                      ? 'No files stored yet. Upload an Excel/CSV file to enable Pallet lookup.'
                      : `No files assigned to group ${formatStoreGroupLabel(lookupGroup)} yet.`}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0 flex-wrap">
                {onNavigate && (
                  <button
                    type="button"
                    onClick={() => onNavigate('uploaded_files')}
                    className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 transition-colors whitespace-nowrap"
                  >
                    Open Uploaded File Page
                  </button>
                )}
              </div>
            </div>

            <div className="pt-2.5 border-t border-slate-100 flex items-center justify-between gap-2 flex-wrap">
              <span className="text-xs font-medium text-slate-600">Pallet Lookup Group Scope:</span>
              <div className="flex items-center gap-1 flex-wrap">
                <button
                  type="button"
                  onClick={() => setLookupGroup('all')}
                  className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors whitespace-nowrap ${
                    lookupGroup === 'all'
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200/70'
                  }`}
                >
                  All Groups ({uploadedFiles.length})
                </button>
                {storeGroups.map((g) => {
                  const cnt = uploadedFiles.filter((f) => f.store_group === g).length;
                  return (
                    <button
                      key={g}
                      type="button"
                      onClick={() => setLookupGroup(g)}
                      className={`rounded-md px-2.5 py-1 text-xs font-mono font-semibold transition-colors whitespace-nowrap ${
                        lookupGroup === g
                          ? 'bg-blue-700 text-white'
                          : 'bg-slate-100 text-slate-700 hover:bg-slate-200/70'
                      }`}
                    >
                      {formatStoreGroupLabel(g)} ({cnt})
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-6 space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label htmlFor="rcv-container" className="block text-xs font-medium text-slate-600">
                  Container / Manifest ID
                </label>
                <input
                  id="rcv-container"
                  type="text"
                  value={containerCode}
                  onChange={(e) => setContainerCode(e.target.value)}
                  className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                />
              </div>
              <div>
                <label htmlFor="rcv-location" className="block text-xs font-medium text-slate-600">
                  Target Location / Bin
                </label>
                <input
                  id="rcv-location"
                  type="text"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                />
              </div>
              <div>
                <label htmlFor="rcv-pallet" className="block text-xs font-medium text-slate-600">
                  Pallet Reference {company.id === 2 || scanMode === 'pallet' ? '(Auto from Pallet QR)' : '(Optional)'}
                </label>
                <input
                  id="rcv-pallet"
                  type="text"
                  value={palletRef}
                  onChange={(e) => setPalletRef(e.target.value)}
                  placeholder="Optional pallet ID"
                  className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                />
              </div>
            </div>

            {/* Scan Mode Selection: Box vs Pallet */}
            <div className="pt-2 border-t border-slate-100 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-medium text-slate-700">
                <Layers className="w-3.5 h-3.5 text-blue-700" />
                <span>Receive Scan Mode</span>
              </div>
              <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg self-start sm:self-auto">
                <button
                  type="button"
                  disabled={isAwaitingAddress}
                  onClick={() => {
                    setScanMode('box');
                    setFeedback(null);
                    setTimeout(() => scanInputRef.current?.focus(), 0);
                  }}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap disabled:opacity-50 ${
                    scanMode === 'box'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <Box className="w-3.5 h-3.5" />
                  <span>Scan by Box</span>
                </button>
                <button
                  type="button"
                  disabled={isAwaitingAddress}
                  onClick={() => {
                    setScanMode('pallet');
                    setFeedback(null);
                    setTimeout(() => scanInputRef.current?.focus(), 0);
                  }}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap disabled:opacity-50 ${
                    scanMode === 'pallet'
                      ? 'bg-blue-700 text-white shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <FileSpreadsheet className="w-3.5 h-3.5" />
                  <span>Scan by Pallet (Uploaded File)</span>
                </button>
              </div>
            </div>

            <div className="pt-2 border-t border-slate-100 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-medium text-slate-700">
                <MapPin className="w-3.5 h-3.5 text-blue-700" />
                <span>Address / Bin Capture</span>
              </div>
              <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg self-start sm:self-auto">
                <button
                  type="button"
                  onClick={() => {
                    setAddressMode('container');
                    setAwaitingAddressItems([]);
                    setTimeout(() => scanInputRef.current?.focus(), 0);
                  }}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                    addressMode === 'container'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Use Default Location
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAddressMode('scan_after_box');
                    setTimeout(() => {
                      if (awaitingAddressItems.length > 0) {
                        addressInputRef.current?.focus();
                      } else {
                        scanInputRef.current?.focus();
                      }
                    }, 0);
                  }}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                    addressMode === 'scan_after_box'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Scan Address After Box
                </button>
              </div>
            </div>

            <form onSubmit={handleFormSubmit} className="pt-2 border-t border-slate-100">
              <label htmlFor="hid-scan-input" className="flex items-center justify-between text-sm font-semibold text-slate-900">
                <span className="inline-flex items-center gap-2">
                  <ScanBarcode className="w-4 h-4 text-blue-700" />
                  <span>
                    {scanMode === 'pallet'
                      ? addressMode === 'scan_after_box'
                        ? 'Step 1: Scan Pallet QR (Refers to Uploaded File)'
                        : 'Scan Pallet QR (Refers to Uploaded File)'
                      : addressMode === 'scan_after_box'
                      ? 'Step 1: Scan Inbound Box QR'
                      : 'Bluetooth HID Scan Input'}
                  </span>
                </span>
                <span className="text-xs font-normal text-slate-500">
                  Scanner sends Enter/CR automatically
                </span>
              </label>

              <div className="mt-2 flex gap-2.5">
                <input
                  ref={scanInputRef}
                  id="hid-scan-input"
                  type="text"
                  value={rawScan}
                  disabled={isAwaitingAddress}
                  onChange={(e) => setRawScan(e.target.value)}
                  placeholder={
                    isAwaitingAddress
                      ? 'Complete Step 2 address scan below before scanning next item...'
                      : scanMode === 'pallet'
                      ? 'Scan pallet barcode matching Col A in Uploaded File (e.g. BUFAJIAN7003/BANII/EC15S6006-401F2703)'
                      : company.id === 1
                      ? `Scan ${company.code} QR (e.g. CA_PN-4402-AL_STD_120_BOX-A401_LOT-2611A)`
                      : `Scan ${company.code} Pallet or Box QR (e.g. BOX/BR-9081-TI&60/BATCH-26B9/BX-3012)`
                  }
                  autoFocus
                  className="flex-1 rounded-lg border border-slate-300 bg-slate-50/60 px-3.5 py-2.5 text-sm font-mono text-slate-900 focus:bg-white focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20 disabled:opacity-60"
                />
                <button
                  type="submit"
                  disabled={parsing || !rawScan.trim() || isAwaitingAddress}
                  className="rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
                >
                  {parsing ? 'Parsing...' : scanMode === 'pallet' ? 'Load Pallet' : 'Stage Scan'}
                </button>
              </div>

              <div className="mt-3 flex items-center gap-2 flex-wrap">
                <span className="text-xs text-slate-500">Test sample input:</span>
                {activeSamples.map((sample) => (
                  <button
                    key={sample.label}
                    type="button"
                    disabled={isAwaitingAddress}
                    onClick={() => void processScan(sample.value)}
                    className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50 transition-colors whitespace-nowrap"
                  >
                    {sample.label}
                  </button>
                ))}
              </div>
            </form>

            {addressMode === 'scan_after_box' && isAwaitingAddress && (
              <form
                onSubmit={handleAddressSubmit}
                className="rounded-xl border border-blue-200 bg-blue-50/70 p-4 space-y-3"
              >
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                      <MapPin className="w-4 h-4 text-blue-700" />
                      <span>Step 2: Scan Warehouse Address / Bin Barcode</span>
                    </div>
                    <div className="text-xs text-slate-600 mt-0.5 font-mono">
                      {awaitingAddressItems.length === 1
                        ? `Pending Box: ${awaitingAddressItems[0].boxId} · ${awaitingAddressItems[0].qty} x ${awaitingAddressItems[0].partNumber}`
                        : `Pending Pallet (${awaitingAddressItems.length} items · ${awaitingAddressItems
                            .reduce((s, it) => s + it.qty, 0)
                            .toLocaleString()} total units): ${awaitingAddressItems
                            .map((it) => `${it.partNumber} (${it.qty})`)
                            .join(', ')}`}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setAwaitingAddressItems([]);
                      setAddressScan('');
                      setTimeout(() => scanInputRef.current?.focus(), 0);
                    }}
                    className="text-xs font-medium text-slate-600 hover:text-red-700 self-start sm:self-auto whitespace-nowrap"
                  >
                    Cancel Pending
                  </button>
                </div>

                <div className="flex gap-2.5">
                  <input
                    ref={addressInputRef}
                    id="address-scan-input"
                    type="text"
                    value={addressScan}
                    onChange={(e) => setAddressScan(e.target.value)}
                    placeholder="Scan rack/bin address barcode (e.g. A-01-R02 or LOC:B-ZONE-01)"
                    className="flex-1 rounded-lg border border-blue-300 bg-white px-3.5 py-2.5 text-sm font-mono text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                  />
                  <button
                    type="submit"
                    disabled={!addressScan.trim()}
                    className="rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
                  >
                    Assign Address
                  </button>
                </div>

                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-xs text-slate-600">Quick address scan:</span>
                  {[location.trim() || 'RCV-DOCK-01', 'A-01-R02', 'A-02-R01', 'B-ZONE-01', 'B-ZONE-03'].map(
                    (preset, i) => (
                      <button
                        key={`${preset}-${i}`}
                        type="button"
                        onClick={() => commitAddressScan(preset)}
                        className="rounded-md border border-blue-200 bg-white px-2.5 py-1 text-xs font-mono font-medium text-slate-800 hover:bg-blue-100/60 transition-colors whitespace-nowrap"
                      >
                        {i === 0 ? `Default (${preset})` : preset}
                      </button>
                    )
                  )}
                </div>
              </form>
            )}

            {feedback && (
              <div
                role="status"
                className={`rounded-lg border px-4 py-3 text-sm flex items-start gap-2.5 ${
                  feedback.kind === 'success'
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                    : feedback.kind === 'warning'
                    ? 'border-amber-200 bg-amber-50 text-amber-900'
                    : 'border-red-200 bg-red-50 text-red-900'
                }`}
              >
                {feedback.kind === 'success' ? (
                  <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-emerald-700" />
                ) : feedback.kind === 'warning' ? (
                  <Info className="w-4 h-4 mt-0.5 shrink-0 text-amber-700" />
                ) : (
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-red-700" />
                )}
                <span>{feedback.text}</span>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-3">
            <h2 className="text-base font-semibold text-slate-900">
              Active QR Profile: {company.code}
            </h2>
            <p className="text-xs leading-relaxed text-slate-600">{company.description}</p>
            <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-xs font-mono text-slate-700 space-y-1.5">
              {company.id === 1 ? (
                <>
                  <div>Delimiter: <span className="font-semibold text-slate-900">_ (underscore)</span></div>
                  <div>Seg 2 → Part Number</div>
                  <div>Seg 4 → Quantity (integer)</div>
                  <div>Seg 5 → Box ID</div>
                  <div>Seg 6 → Batch / Reference (optional)</div>
                </>
              ) : (
                <>
                  <div>Delimiter: <span className="font-semibold text-slate-900">/ (slash)</span></div>
                  <div>Pallet QR (<span className="text-slate-900">PLT/...</span>) → Reference only (no stock)</div>
                  <div>Box Seg 2 → <span className="text-slate-900">Part&amp;Qty</span> (split by &amp;)</div>
                  <div>Box Seg 3 → Batch · Seg 4 → Box ID</div>
                </>
              )}
            </div>
          </div>

          {lastParse && (
            <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-base font-semibold text-slate-900">Raw Scanner Segment Inspector</h2>
                <span className="font-mono text-xs text-slate-500">{lastParse.profile}</span>
              </div>
              <div className="rounded-lg bg-slate-900 text-slate-100 p-3 font-mono text-xs break-all">
                {lastParse.rawInput}
              </div>
              {lastParse.strippedAimPrefix && (
                <div className="text-xs text-slate-600">
                  Stripped AIM scanner prefix: <span className="font-mono font-semibold">{lastParse.strippedAimPrefix}</span>
                </div>
              )}
              <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg overflow-hidden">
                {lastParse.segments.map((seg, idx) => (
                  <div key={idx} className="px-3 py-2 flex items-center justify-between gap-3 text-xs bg-white">
                    <span className="text-slate-500 font-mono">Segment {idx + 1}</span>
                    <span className="font-mono font-medium text-slate-900 truncate">{seg || '(empty)'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200">
              <h2 className="text-base font-semibold text-slate-900">Recent Completed Containers</h2>
            </div>
            <div className="divide-y divide-slate-100">
              {containers.length === 0 ? (
                <div className="px-5 py-6 text-sm text-slate-500 text-center">No containers completed yet.</div>
              ) : (
                containers.slice(0, 6).map((c) => (
                  <div key={c.id} className="px-5 py-3 flex items-center justify-between gap-4">
                    <div>
                      <div className="font-mono text-sm font-semibold text-slate-900">{c.container_code}</div>
                      <div className="text-xs text-slate-500">
                        {c.location} · by {c.received_by}
                        {c.pallet_ref ? ` · ${c.pallet_ref}` : ''}
                      </div>
                    </div>
                    <div className="text-right font-mono tabular-nums">
                      <div className="text-sm font-semibold text-slate-900">{c.total_units.toLocaleString()} units</div>
                      <div className="text-xs text-slate-500">{c.total_boxes} boxes</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="lg:col-span-5 space-y-6">
          <div className="rounded-xl border border-slate-200 bg-white overflow-hidden sticky top-6">
            <div className="px-5 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  Pending Container Scans ({pendingScans.length} boxes ·{' '}
                  <span className="font-mono tabular-nums">{totalPendingUnits.toLocaleString()}</span> units)
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Staged in browser memory — do not reload before completing container.
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {pendingScans.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      onPendingScansChange([]);
                      focusActiveScanner();
                    }}
                    className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap"
                  >
                    Clear Staged
                  </button>
                )}
                <button
                  type="button"
                  disabled={pendingScans.length === 0 || committing}
                  onClick={() => {
                    setReviewError(null);
                    setReviewOpen(true);
                  }}
                  className="inline-flex items-center gap-2 rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-50 transition-colors whitespace-nowrap"
                >
                  <ClipboardCheck className="w-4 h-4" />
                  <span>Finish Scan &amp; Review</span>
                </button>
              </div>
            </div>

            <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-50 z-10 shadow-xs">
                  <tr className="border-b border-slate-200 text-left text-xs font-medium text-slate-500">
                    <th className="px-4 py-2.5">Box ID</th>
                    <th className="px-3 py-2.5">Part Number</th>
                    <th className="px-3 py-2.5 text-right">Qty</th>
                    <th className="px-3 py-2.5">Bin</th>
                    <th className="px-3 py-2.5 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {pendingScans.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-5 py-10 text-center text-sm text-slate-500">
                        Scanner ready. Scan a box QR code or use a sample test button above to stage items.
                      </td>
                    </tr>
                  ) : (
                    pendingScans.map((item) => (
                      <tr key={item.localId} className="hover:bg-slate-50/80 transition-colors">
                        <td className="px-4 py-3 font-mono font-medium text-slate-900 truncate max-w-[120px]" title={item.boxId}>
                          {item.boxId}
                        </td>
                        <td className="px-3 py-3 font-mono text-slate-900 truncate max-w-[110px]" title={item.partNumber}>
                          {item.partNumber}
                        </td>
                        <td className="px-3 py-3 text-right font-mono tabular-nums font-semibold text-slate-900">
                          {item.qty}
                        </td>
                        <td className="px-3 py-3 font-mono text-xs font-medium text-slate-800 truncate max-w-[90px]" title={item.location || location}>
                          {item.location || location}
                        </td>
                        <td className="px-3 py-3 text-right">
                          <button
                            type="button"
                            onClick={() => {
                              onPendingScansChange((prev) => prev.filter((p) => p.localId !== item.localId));
                              focusActiveScanner();
                            }}
                            aria-label={`Remove box ${item.boxId}`}
                            className="inline-flex items-center justify-center rounded-md p-1.5 text-slate-400 hover:text-red-700 hover:bg-red-50 transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
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

      {/* Container Review & Submit Window */}
      {reviewOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="review-modal-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 sm:p-6"
          onClick={(e) => {
            if (e.target === e.currentTarget && !committing) {
              setReviewOpen(false);
            }
          }}
        >
          <div className="w-full max-w-4xl max-h-[90vh] bg-white rounded-xl border border-slate-200 shadow-xl flex flex-col overflow-hidden">
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4 shrink-0">
              <div>
                <h2 id="review-modal-title" className="text-lg font-bold tracking-tight text-slate-900">
                  Container Review &amp; Submit
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  {company.code} · Verify scanned quantities and container details before storing in the system.
                </p>
              </div>
              <button
                type="button"
                disabled={committing}
                onClick={() => setReviewOpen(false)}
                aria-label="Close review window"
                className="rounded-lg p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Scrollable Body */}
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {/* Editable Container Details */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label htmlFor="review-container" className="block text-xs font-medium text-slate-600">
                    Container / Manifest ID
                  </label>
                  <input
                    id="review-container"
                    type="text"
                    value={containerCode}
                    onChange={(e) => setContainerCode(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                  />
                </div>
                <div>
                  <label htmlFor="review-location" className="block text-xs font-medium text-slate-600">
                    Target Location / Bin
                  </label>
                  <input
                    id="review-location"
                    type="text"
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                  />
                </div>
                <div>
                  <label htmlFor="review-pallet" className="block text-xs font-medium text-slate-600">
                    Pallet Reference
                  </label>
                  <input
                    id="review-pallet"
                    type="text"
                    value={palletRef}
                    onChange={(e) => setPalletRef(e.target.value)}
                    placeholder="None"
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                  />
                </div>
              </div>

              {/* Totals Strip */}
              <div className="grid grid-cols-3 gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
                <div>
                  <div className="text-xs text-slate-500">Total Boxes Scanned</div>
                  <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-slate-900">
                    {pendingScans.length}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500">Distinct Part Numbers</div>
                  <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-slate-900">
                    {groupedBySku.length}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500">Total Units to Store</div>
                  <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-blue-700">
                    {totalPendingUnits.toLocaleString()}
                  </div>
                </div>
              </div>

              {/* Summary by SKU */}
              <div className="rounded-xl border border-slate-200 overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-200 bg-slate-50/70">
                  <h3 className="text-sm font-semibold text-slate-900">Part Number Tally</h3>
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs font-medium text-slate-500">
                      <th className="px-4 py-2">Part Number</th>
                      <th className="px-4 py-2 text-right">Boxes</th>
                      <th className="px-4 py-2 text-right">Total Units</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {groupedBySku.map((g) => (
                      <tr key={g.partNumber}>
                        <td className="px-4 py-2.5 font-mono font-semibold text-slate-900">{g.partNumber}</td>
                        <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-700">{g.boxes}</td>
                        <td className="px-4 py-2.5 text-right font-mono tabular-nums font-semibold text-slate-900">
                          {g.totalQty.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Individual Scanned Boxes */}
              <div className="rounded-xl border border-slate-200 overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-200 bg-slate-50/70">
                  <h3 className="text-sm font-semibold text-slate-900">
                    Scanned Box Manifest ({pendingScans.length})
                  </h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 text-left text-xs font-medium text-slate-500">
                        <th className="px-4 py-2">#</th>
                        <th className="px-4 py-2">Box ID</th>
                        <th className="px-4 py-2">Part Number</th>
                        <th className="px-4 py-2 text-right">Qty</th>
                        <th className="px-4 py-2">Address / Bin</th>
                        <th className="px-4 py-2">Batch / Ref</th>
                        <th className="px-4 py-2 text-right">Remove</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {pendingScans.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="px-4 py-6 text-center text-sm text-slate-500">
                            All staged boxes were removed. Go back to scan boxes.
                          </td>
                        </tr>
                      ) : (
                        pendingScans.map((item, idx) => (
                          <tr key={item.localId} className="hover:bg-slate-50/70">
                            <td className="px-4 py-2.5 font-mono tabular-nums text-xs text-slate-500">
                              {idx + 1}
                            </td>
                            <td className="px-4 py-2.5 font-mono font-medium text-slate-900">{item.boxId}</td>
                            <td className="px-4 py-2.5 font-mono text-slate-800">{item.partNumber}</td>
                            <td className="px-4 py-2.5 text-right font-mono tabular-nums font-semibold text-slate-900">
                              {item.qty}
                            </td>
                            <td className="px-4 py-2.5 font-mono text-xs font-medium text-slate-800">
                              {item.location || location}
                            </td>
                            <td className="px-4 py-2.5 font-mono text-xs text-slate-600">
                              {item.batchRef || '—'}
                              {item.palletRef ? ` · ${item.palletRef}` : ''}
                            </td>
                            <td className="px-4 py-2.5 text-right">
                              <button
                                type="button"
                                disabled={committing}
                                onClick={() =>
                                  onPendingScansChange((prev) =>
                                    prev.filter((p) => p.localId !== item.localId)
                                  )
                                }
                                aria-label={`Remove box ${item.boxId}`}
                                className="inline-flex items-center justify-center rounded-md p-1 text-slate-400 hover:text-red-700 hover:bg-red-50 transition-colors"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {reviewError && (
                <div
                  role="alert"
                  className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 flex items-center gap-2"
                >
                  <AlertTriangle className="w-4 h-4 shrink-0 text-red-700" />
                  <span>{reviewError}</span>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3 shrink-0">
              <button
                type="button"
                disabled={committing}
                onClick={() => {
                  setReviewOpen(false);
                  setTimeout(() => scanInputRef.current?.focus(), 0);
                }}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap"
              >
                <ArrowLeft className="w-4 h-4" />
                <span>Back to Scanning</span>
              </button>

              <button
                type="button"
                disabled={pendingScans.length === 0 || committing}
                onClick={() => void handleCompleteContainer()}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-50 transition-colors whitespace-nowrap"
              >
                <PackageCheck className="w-4 h-4" />
                <span>
                  {committing
                    ? 'Storing in System...'
                    : `Submit & Store in System (${pendingScans.length} boxes)`}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
