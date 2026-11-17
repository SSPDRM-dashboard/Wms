import React, { useEffect, useRef, useState } from 'react';
import {
  Send,
  CheckCircle2,
  AlertTriangle,
  ScanBarcode,
  Volume2,
  VolumeX,
  Trash2,
  ClipboardCheck,
  X,
  ArrowLeft,
  Info,
  PackageCheck,
} from 'lucide-react';
import { api } from '../api';
import { playScanFeedback } from '../utils/audio';
import type {
  Company,
  FifoPreview,
  InventoryLot,
  MovementRecord,
  ParsedQrResult,
  PendingOutboundItem,
  SkuSummary,
} from '../types';

interface OutboundFifoViewProps {
  company: Company;
  preselectedPart?: string | null;
  pendingScans: PendingOutboundItem[];
  onPendingScansChange: React.Dispatch<React.SetStateAction<PendingOutboundItem[]>>;
}

export function OutboundFifoView({
  company,
  preselectedPart,
  pendingScans = [],
  onPendingScansChange,
}: OutboundFifoViewProps) {
  const scanInputRef = useRef<HTMLInputElement>(null);

  const [mode, setMode] = useState<'scanner' | 'manual'>(
    preselectedPart ? 'manual' : 'scanner'
  );

  // Shared shipment header fields
  const [referenceCode, setReferenceCode] = useState(
    () => `SO-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-01`
  );
  const [destination, setDestination] = useState('SHIP-BAY-01');
  const [palletRef, setPalletRef] = useState('');

  // Scanner mode state
  const [rawScan, setRawScan] = useState('');
  const [muted, setMuted] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [lastParse, setLastParse] = useState<ParsedQrResult | null>(null);
  const [scanFeedback, setScanFeedback] = useState<{
    kind: 'success' | 'warning' | 'error';
    text: string;
  } | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [activeLots, setActiveLots] = useState<InventoryLot[]>([]);
  const [recentOutbounds, setRecentOutbounds] = useState<MovementRecord[]>([]);

  // Manual FIFO auto-allocate mode state
  const [skus, setSkus] = useState<SkuSummary[]>([]);
  const [locations, setLocations] = useState<string[]>([]);
  const [partNumber, setPartNumber] = useState(preselectedPart || '');
  const [qty, setQty] = useState('50');
  const [location, setLocation] = useState('');
  const [preview, setPreview] = useState<FifoPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [submittingManual, setSubmittingManual] = useState(false);
  const [manualFeedback, setManualFeedback] = useState<{
    kind: 'success' | 'error';
    text: string;
  } | null>(null);

  async function loadInventoryAndRecent() {
    try {
      const [invRes, moveRes] = await Promise.all([
        api.getInventory(company.id),
        api.getMovements(company.id, 'OUTBOUND_FIFO'),
      ]);
      setActiveLots(invRes.lots);
      setSkus(invRes.skuSummary);
      setLocations(invRes.locations);
      setRecentOutbounds(moveRes.movements.slice(0, 8));

      if (preselectedPart && invRes.skuSummary.some((s) => s.part_number === preselectedPart)) {
        setPartNumber(preselectedPart);
      } else if (!partNumber || !invRes.skuSummary.some((s) => s.part_number === partNumber)) {
        setPartNumber(invRes.skuSummary[0]?.part_number || '');
      }
    } catch {
      // Non-blocking
    }
  }

  function focusScanner() {
    if (mode !== 'scanner' || reviewOpen) return;
    requestAnimationFrame(() => {
      scanInputRef.current?.focus();
    });
  }

  useEffect(() => {
    setLocation('');
    setPalletRef('');
    setLastParse(null);
    setScanFeedback(null);
    setManualFeedback(null);
    setReviewOpen(false);
    setReviewError(null);
    if (preselectedPart) {
      setMode('manual');
    }
    void loadInventoryAndRecent();
  }, [company.id, preselectedPart]);

  useEffect(() => {
    if (mode !== 'scanner' || reviewOpen || parsing) return;
    const frameId = requestAnimationFrame(() => {
      scanInputRef.current?.focus();
    });
    return () => cancelAnimationFrame(frameId);
  }, [company.id, mode, parsing, reviewOpen]);

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

  useEffect(() => {
    if (mode !== 'manual') return;
    const numQty = Number(qty);
    if (!partNumber || !Number.isInteger(numQty) || numQty <= 0) {
      setPreview(null);
      return;
    }

    let cancelled = false;
    setLoadingPreview(true);
    api
      .previewOutboundFifo(company.id, partNumber, numQty, location)
      .then((plan) => {
        if (!cancelled) setPreview(plan);
      })
      .catch(() => {
        if (!cancelled) setPreview(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingPreview(false);
      });

    return () => {
      cancelled = true;
    };
  }, [company.id, partNumber, qty, location, mode]);

  async function processOutboundScan(inputStr: string) {
    const trimmed = inputStr.trim();
    if (!trimmed) return;
    setParsing(true);
    setScanFeedback(null);

    try {
      const res = await api.scanOutbound(company.id, trimmed);
      setLastParse(res.parsed);

      if (!res.parsed.valid) {
        playScanFeedback('error', muted);
        setScanFeedback({ kind: 'error', text: res.parsed.message });
        setRawScan('');
        return;
      }

      if (res.parsed.kind === 'pallet_reference') {
        playScanFeedback('pallet', muted);
        setPalletRef(res.parsed.palletRef || '');
        setScanFeedback({
          kind: 'warning',
          text: `Outbound Pallet Reference "${res.parsed.palletRef}" set. Scan individual box QR codes to stage shipment.`,
        });
        setRawScan('');
        return;
      }

      const lot = res.matchedLot;
      if (!lot) {
        playScanFeedback('error', muted);
        setScanFeedback({
          kind: 'error',
          text: `Box "${res.parsed.boxId}" is not in active inventory for ${company.code}.`,
        });
        setRawScan('');
        return;
      }

      // Check duplicate box already staged in this outbound batch (exempt for 60-batches where box numbers can be the same)
      const is60Batch = String(lot.batch_ref || '').toLowerCase().includes('60');
      const duplicate = is60Batch
        ? pendingScans.find((item) => item.lotId === lot.id)
        : pendingScans.find(
            (item) => item.lotId === lot.id || item.boxId.toLowerCase() === lot.box_id.toLowerCase()
          );
      if (duplicate) {
        playScanFeedback('error', muted);
        setScanFeedback({
          kind: 'error',
          text: `Duplicate box scan blocked: Box "${lot.box_id}" is already staged for outbound.`,
        });
        setRawScan('');
        return;
      }

      const parsedQty = res.parsed.qty ?? lot.qty;
      const defaultIssueQty = Math.min(parsedQty, lot.qty);
      const olderNote = res.olderFifoLot
        ? `Older FIFO lot available: ${res.olderFifoLot.box_id} (${res.olderFifoLot.qty} units @ ${res.olderFifoLot.location}, received ${new Date(
            res.olderFifoLot.received_at
          ).toLocaleDateString()})`
        : null;

      playScanFeedback(olderNote ? 'pallet' : 'success', muted);
      const newItem: PendingOutboundItem = {
        localId: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        lotId: lot.id,
        partNumber: lot.part_number,
        qty: defaultIssueQty,
        availableQty: lot.qty,
        boxId: lot.box_id,
        batchRef: lot.batch_ref,
        location: lot.location,
        receivedAt: lot.received_at,
        rawScan: res.parsed.cleanedInput,
        scannedAt: new Date().toISOString(),
        olderFifoNotice: olderNote,
      };

      onPendingScansChange((prev) => [newItem, ...prev]);
      setScanFeedback({
        kind: olderNote ? 'warning' : 'success',
        text: olderNote
          ? `Staged ${newItem.boxId} (${newItem.qty} x ${newItem.partNumber}). ${olderNote}`
          : `Staged ${newItem.boxId} · ${newItem.qty} units of ${newItem.partNumber} from ${newItem.location}`,
      });
      setRawScan('');
    } catch (err) {
      playScanFeedback('error', muted);
      setScanFeedback({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Outbound scan failed.',
      });
      setRawScan('');
    } finally {
      setParsing(false);
    }
  }

  function handleScanSubmit(e: React.FormEvent) {
    e.preventDefault();
    void processOutboundScan(rawScan);
  }

  async function handleCompleteOutbound() {
    if (pendingScans.length === 0) return;
    if (!referenceCode.trim()) {
      setReviewError('Shipment / Order Reference is required before submitting.');
      return;
    }

    setCommitting(true);
    setReviewError(null);
    setScanFeedback(null);

    try {
      const res = await api.completeOutbound({
        company_id: company.id,
        reference_code: referenceCode.trim(),
        destination: destination.trim() || 'DISPATCH',
        pallet_ref: palletRef.trim(),
        items: pendingScans.map((s) => ({
          lotId: s.lotId,
          boxId: s.boxId,
          partNumber: s.partNumber,
          qty: s.qty,
        })),
      });

      playScanFeedback('success', muted);
      onPendingScansChange([]);
      setPalletRef('');
      setReviewOpen(false);
      setScanFeedback({
        kind: 'success',
        text: `Outbound ${res.referenceCode} stored in system: ${res.totalBoxes} boxes (${res.totalUnits} units) issued to ${res.destination}.`,
      });
      await loadInventoryAndRecent();
    } catch (err) {
      playScanFeedback('error', muted);
      const msg = err instanceof Error ? err.message : 'Failed to issue outbound shipment.';
      setReviewError(msg);
      setScanFeedback({ kind: 'error', text: msg });
    } finally {
      setCommitting(false);
    }
  }

  async function handleManualSubmit(e: React.FormEvent) {
    e.preventDefault();
    const numQty = Number(qty);
    if (!partNumber || !Number.isInteger(numQty) || numQty <= 0) return;

    setSubmittingManual(true);
    setManualFeedback(null);
    try {
      const res = await api.executeOutboundFifo({
        company_id: company.id,
        part_number: partNumber,
        qty: numQty,
        reference_code: referenceCode.trim() || 'OUTBOUND',
        destination: destination.trim() || 'DISPATCH',
        location: location || undefined,
      });

      setManualFeedback({
        kind: 'success',
        text: `Issued ${res.issuedQty} units of ${res.partNumber} across ${res.allocations.length} FIFO lot(s) for ${res.referenceCode}.`,
      });
      await loadInventoryAndRecent();
      const nextPlan = await api.previewOutboundFifo(company.id, partNumber, numQty, location);
      setPreview(nextPlan);
    } catch (err) {
      setManualFeedback({
        kind: 'error',
        text: err instanceof Error ? err.message : 'FIFO outbound issue failed.',
      });
    } finally {
      setSubmittingManual(false);
    }
  }

  const totalPendingUnits = pendingScans.reduce((sum, item) => sum + item.qty, 0);

  const groupedBySku = Object.values(
    pendingScans.reduce<Record<string, { partNumber: string; boxes: number; totalQty: number }>>(
      (acc, item) => {
        if (!acc[item.partNumber]) {
          acc[item.partNumber] = { partNumber: item.partNumber, boxes: 0, totalQty: 0 };
        }
        acc[item.partNumber].boxes += 1;
        acc[item.partNumber].totalQty += item.qty;
        return acc;
      },
      {}
    )
  ).sort((a, b) => a.partNumber.localeCompare(b.partNumber));

  // Build quick-test QR buttons from real active inventory lots so operators can test immediately
  const quickBoxSamples = activeLots.slice(0, 2).map((lot) => ({
    label: `Scan ${lot.box_id} (${lot.qty} x ${lot.part_number})`,
    value:
      company.id === 1
        ? `CA_${lot.part_number}_STD_${lot.qty}_${lot.box_id}${lot.batch_ref ? `_${lot.batch_ref}` : ''}`
        : `BOX/${lot.part_number}&${lot.qty}/${lot.batch_ref || 'LOT'}/${lot.box_id}`,
  }));

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Outbound Issuing &amp; Scanner Dispatch
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            {company.name} ·{' '}
            {mode === 'scanner'
              ? 'Scan all outbound boxes, then open the review window to verify and submit.'
              : 'Auto-allocate oldest received lots first by Part Number.'}
          </p>
        </div>

        <div className="flex items-center gap-3 flex-wrap shrink-0">
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
            <button
              type="button"
              onClick={() => {
                setMode('scanner');
                setTimeout(() => scanInputRef.current?.focus(), 0);
              }}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                mode === 'scanner'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Scanner Staging (Box QR)
            </button>
            <button
              type="button"
              onClick={() => setMode('manual')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                mode === 'manual'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Manual FIFO Auto-Pick
            </button>
          </div>

          {mode === 'scanner' && (
            <button
              type="button"
              onClick={() => {
                setMuted((m) => !m);
                focusScanner();
              }}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
            >
              {muted ? (
                <VolumeX className="w-4 h-4 text-slate-400" />
              ) : (
                <Volume2 className="w-4 h-4 text-blue-700" />
              )}
              <span>{muted ? 'Audio Muted' : 'Audio On'}</span>
            </button>
          )}
        </div>
      </div>

      {mode === 'scanner' ? (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            <div className="lg:col-span-7 space-y-6">
              <div className="rounded-xl border border-slate-200 bg-white p-6 space-y-5">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <label htmlFor="out-ref" className="block text-xs font-medium text-slate-600">
                      Order / Work Order Ref
                    </label>
                    <input
                      id="out-ref"
                      type="text"
                      value={referenceCode}
                      onChange={(e) => setReferenceCode(e.target.value)}
                      className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                    />
                  </div>
                  <div>
                    <label htmlFor="out-dest" className="block text-xs font-medium text-slate-600">
                      Destination / Ship Bay
                    </label>
                    <input
                      id="out-dest"
                      type="text"
                      value={destination}
                      onChange={(e) => setDestination(e.target.value)}
                      className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                    />
                  </div>
                  <div>
                    <label htmlFor="out-pallet" className="block text-xs font-medium text-slate-600">
                      Outbound Pallet Ref (Optional)
                    </label>
                    <input
                      id="out-pallet"
                      type="text"
                      value={palletRef}
                      onChange={(e) => setPalletRef(e.target.value)}
                      placeholder="Optional pallet ID"
                      className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                    />
                  </div>
                </div>

                <form onSubmit={handleScanSubmit} className="pt-2 border-t border-slate-100">
                  <label
                    htmlFor="outbound-hid-scan"
                    className="flex items-center justify-between text-sm font-semibold text-slate-900"
                  >
                    <span className="inline-flex items-center gap-2">
                      <ScanBarcode className="w-4 h-4 text-blue-700" />
                      <span>Bluetooth HID Scan Input</span>
                    </span>
                    <span className="text-xs font-normal text-slate-500">
                      Scanner sends Enter/CR automatically
                    </span>
                  </label>

                  <div className="mt-2 flex gap-2.5">
                    <input
                      ref={scanInputRef}
                      id="outbound-hid-scan"
                      type="text"
                      value={rawScan}
                      onChange={(e) => setRawScan(e.target.value)}
                      placeholder={
                        company.id === 1
                          ? `Scan ${company.code} Box QR in stock to stage outbound...`
                          : `Scan ${company.code} Pallet or Box QR in stock to stage outbound...`
                      }
                      autoFocus
                      className="flex-1 rounded-lg border border-slate-300 bg-slate-50/60 px-3.5 py-2.5 text-sm font-mono text-slate-900 focus:bg-white focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                    />
                    <button
                      type="submit"
                      disabled={parsing || !rawScan.trim()}
                      className="rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
                    >
                      {parsing ? 'Checking...' : 'Stage Box'}
                    </button>
                  </div>

                  {quickBoxSamples.length > 0 && (
                    <div className="mt-3 flex items-center gap-2 flex-wrap">
                      <span className="text-xs text-slate-500">Test with active stock:</span>
                      {quickBoxSamples.map((sample) => (
                        <button
                          key={sample.value}
                          type="button"
                          onClick={() => void processOutboundScan(sample.value)}
                          className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 transition-colors whitespace-nowrap"
                        >
                          {sample.label}
                        </button>
                      ))}
                    </div>
                  )}
                </form>

                {scanFeedback && (
                  <div
                    role="status"
                    className={`rounded-lg border px-4 py-3 text-sm flex items-start gap-2.5 ${
                      scanFeedback.kind === 'success'
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                        : scanFeedback.kind === 'warning'
                        ? 'border-amber-200 bg-amber-50 text-amber-900'
                        : 'border-red-200 bg-red-50 text-red-900'
                    }`}
                  >
                    {scanFeedback.kind === 'success' ? (
                      <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-emerald-700" />
                    ) : scanFeedback.kind === 'warning' ? (
                      <Info className="w-4 h-4 mt-0.5 shrink-0 text-amber-700" />
                    ) : (
                      <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-red-700" />
                    )}
                    <span>{scanFeedback.text}</span>
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div>
                    <h2 className="text-base font-semibold text-slate-900">
                      Pending Outbound Scans ({pendingScans.length} boxes ·{' '}
                      <span className="font-mono tabular-nums">{totalPendingUnits.toLocaleString()}</span> units)
                    </h2>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Staged in browser memory — review and submit to deduct inventory.
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {pendingScans.length > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          onPendingScansChange([]);
                          focusScanner();
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

                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50/70 text-left text-xs font-medium text-slate-500">
                        <th className="px-5 py-2.5">Box ID</th>
                        <th className="px-4 py-2.5">Part Number</th>
                        <th className="px-4 py-2.5">Location</th>
                        <th className="px-4 py-2.5 text-right">On Hand</th>
                        <th className="px-4 py-2.5 text-right">Issue Qty</th>
                        <th className="px-4 py-2.5 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {pendingScans.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="px-5 py-10 text-center text-sm text-slate-500">
                            {activeLots.length === 0
                              ? `No active stock in ${company.code}. Receive inventory first before scanning outbound.`
                              : 'Scanner ready. Scan an active box QR code to stage it for outbound dispatch.'}
                          </td>
                        </tr>
                      ) : (
                        pendingScans.map((item) => (
                          <tr key={item.localId} className="hover:bg-slate-50/80 transition-colors">
                            <td className="px-5 py-3">
                              <div className="font-mono font-medium text-slate-900">{item.boxId}</div>
                              {item.batchRef && (
                                <div className="font-mono text-[11px] text-slate-500">{item.batchRef}</div>
                              )}
                            </td>
                            <td className="px-4 py-3 font-mono text-slate-900">{item.partNumber}</td>
                            <td className="px-4 py-3 font-mono text-xs text-slate-600">{item.location}</td>
                            <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-600">
                              {item.availableQty}
                            </td>
                            <td className="px-4 py-3 text-right font-mono tabular-nums font-semibold text-slate-900">
                              {item.qty}
                            </td>
                            <td className="px-4 py-3 text-right">
                              <button
                                type="button"
                                onClick={() => {
                                  onPendingScansChange((prev) =>
                                    prev.filter((p) => p.localId !== item.localId)
                                  );
                                  focusScanner();
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

            <div className="lg:col-span-5 space-y-6">
              <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-3">
                <h2 className="text-base font-semibold text-slate-900">
                  Outbound QR Matching ({company.code})
                </h2>
                <p className="text-xs leading-relaxed text-slate-600">
                  Scans use the same {company.qr_profile} QR profile as inbound receiving and match the scanned Box ID against active inventory lots.
                </p>
                <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-xs font-mono text-slate-700 space-y-1.5">
                  <div>Active In-Stock Lots: <span className="font-semibold text-slate-900">{activeLots.length}</span></div>
                  <div>Duplicate boxes in staging are blocked automatically.</div>
                  <div>FIFO advisory alerts if an older box of the same part is on hand.</div>
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
                  <h2 className="text-base font-semibold text-slate-900">Recent Outbound Issues</h2>
                </div>
                <div className="divide-y divide-slate-100">
                  {recentOutbounds.length === 0 ? (
                    <div className="px-5 py-6 text-sm text-slate-500 text-center">
                      No outbound shipments recorded yet.
                    </div>
                  ) : (
                    recentOutbounds.map((m) => (
                      <div key={m.id} className="px-5 py-3 flex items-center justify-between gap-4">
                        <div>
                          <div className="font-mono text-sm font-semibold text-slate-900">
                            {m.part_number} · {m.box_id}
                          </div>
                          <div className="text-xs text-slate-500">
                            {m.from_location} → {m.to_location} · {m.reference_code}
                          </div>
                        </div>
                        <div className="text-right font-mono tabular-nums">
                          <div className="text-sm font-semibold text-red-700">{m.qty_delta}</div>
                          <div className="text-xs text-slate-500">{m.performed_by}</div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Outbound Review & Submit Window */}
          {reviewOpen && (
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="outbound-review-title"
              className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 sm:p-6"
              onClick={(e) => {
                if (e.target === e.currentTarget && !committing) {
                  setReviewOpen(false);
                }
              }}
            >
              <div className="w-full max-w-4xl max-h-[90vh] bg-white rounded-xl border border-slate-200 shadow-xl flex flex-col overflow-hidden">
                <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4 shrink-0">
                  <div>
                    <h2 id="outbound-review-title" className="text-lg font-bold tracking-tight text-slate-900">
                      Outbound Review &amp; Submit
                    </h2>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {company.code} · Verify scanned boxes and quantities before deducting from system stock.
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={committing}
                    onClick={() => setReviewOpen(false)}
                    aria-label="Close outbound review window"
                    className="rounded-lg p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto p-6 space-y-6">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div>
                      <label htmlFor="rev-out-ref" className="block text-xs font-medium text-slate-600">
                        Order / Work Order Ref
                      </label>
                      <input
                        id="rev-out-ref"
                        type="text"
                        value={referenceCode}
                        onChange={(e) => setReferenceCode(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                      />
                    </div>
                    <div>
                      <label htmlFor="rev-out-dest" className="block text-xs font-medium text-slate-600">
                        Destination / Ship Bay
                      </label>
                      <input
                        id="rev-out-dest"
                        type="text"
                        value={destination}
                        onChange={(e) => setDestination(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                      />
                    </div>
                    <div>
                      <label htmlFor="rev-out-pallet" className="block text-xs font-medium text-slate-600">
                        Outbound Pallet Ref
                      </label>
                      <input
                        id="rev-out-pallet"
                        type="text"
                        value={palletRef}
                        onChange={(e) => setPalletRef(e.target.value)}
                        placeholder="None"
                        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                      />
                    </div>
                  </div>

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
                      <div className="text-xs text-slate-500">Total Units to Issue</div>
                      <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-blue-700">
                        {totalPendingUnits.toLocaleString()}
                      </div>
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-200 overflow-hidden">
                    <div className="px-4 py-3 border-b border-slate-200 bg-slate-50/70">
                      <h3 className="text-sm font-semibold text-slate-900">Part Number Tally</h3>
                    </div>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-slate-200 text-left text-xs font-medium text-slate-500">
                          <th className="px-4 py-2">Part Number</th>
                          <th className="px-4 py-2 text-right">Boxes</th>
                          <th className="px-4 py-2 text-right">Total Issue Qty</th>
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

                  <div className="rounded-xl border border-slate-200 overflow-hidden">
                    <div className="px-4 py-3 border-b border-slate-200 bg-slate-50/70">
                      <h3 className="text-sm font-semibold text-slate-900">
                        Scanned Outbound Box Manifest ({pendingScans.length})
                      </h3>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-slate-200 text-left text-xs font-medium text-slate-500">
                            <th className="px-4 py-2">#</th>
                            <th className="px-4 py-2">Box ID</th>
                            <th className="px-4 py-2">Part Number</th>
                            <th className="px-4 py-2">Location</th>
                            <th className="px-4 py-2 text-right">Issue Qty</th>
                            <th className="px-4 py-2 text-right">Remove</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {pendingScans.length === 0 ? (
                            <tr>
                              <td colSpan={6} className="px-4 py-6 text-center text-sm text-slate-500">
                                All staged boxes were removed. Go back to scan boxes.
                              </td>
                            </tr>
                          ) : (
                            pendingScans.map((item, idx) => (
                              <tr key={item.localId} className="hover:bg-slate-50/70">
                                <td className="px-4 py-2.5 font-mono tabular-nums text-xs text-slate-500">
                                  {idx + 1}
                                </td>
                                <td className="px-4 py-2.5 font-mono font-medium text-slate-900">
                                  {item.boxId}
                                  {item.olderFifoNotice && (
                                    <span className="block text-[11px] font-sans text-amber-700">
                                      {item.olderFifoNotice}
                                    </span>
                                  )}
                                </td>
                                <td className="px-4 py-2.5 font-mono text-slate-800">{item.partNumber}</td>
                                <td className="px-4 py-2.5 font-mono text-xs text-slate-600">{item.location}</td>
                                <td className="px-4 py-2.5 text-right font-mono tabular-nums font-semibold text-slate-900">
                                  {item.qty} / {item.availableQty}
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
                    onClick={() => void handleCompleteOutbound()}
                    className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-50 transition-colors whitespace-nowrap"
                  >
                    <PackageCheck className="w-4 h-4" />
                    <span>
                      {committing
                        ? 'Submitting Outbound...'
                        : `Submit & Issue Outbound (${pendingScans.length} boxes)`}
                    </span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <form
            onSubmit={handleManualSubmit}
            className="lg:col-span-5 rounded-xl border border-slate-200 bg-white p-6 space-y-4"
          >
            <h2 className="text-base font-semibold text-slate-900">FIFO Auto-Allocate Details</h2>

            <div>
              <label htmlFor="fifo-part" className="block text-xs font-medium text-slate-600">
                Part Number
              </label>
              <select
                id="fifo-part"
                value={partNumber}
                onChange={(e) => setPartNumber(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm font-mono text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
              >
                {skus.length === 0 ? (
                  <option value="">No stock available</option>
                ) : (
                  skus.map((s) => (
                    <option key={s.part_number} value={s.part_number}>
                      {s.part_number} ({s.total_qty.toLocaleString()} available)
                    </option>
                  ))
                )}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="fifo-qty" className="block text-xs font-medium text-slate-600">
                  Quantity to Issue
                </label>
                <input
                  id="fifo-qty"
                  type="number"
                  min={1}
                  step={1}
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  required
                  className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm font-mono tabular-nums text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                />
              </div>
              <div>
                <label htmlFor="fifo-loc" className="block text-xs font-medium text-slate-600">
                  Source Location Filter
                </label>
                <select
                  id="fifo-loc"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm font-mono text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                >
                  <option value="">Any Location (Global FIFO)</option>
                  {locations.map((loc) => (
                    <option key={loc} value={loc}>
                      {loc}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="fifo-ref" className="block text-xs font-medium text-slate-600">
                  Order / Work Order Ref
                </label>
                <input
                  id="fifo-ref"
                  type="text"
                  value={referenceCode}
                  onChange={(e) => setReferenceCode(e.target.value)}
                  className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm font-mono text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                />
              </div>
              <div>
                <label htmlFor="fifo-dest" className="block text-xs font-medium text-slate-600">
                  Destination / Line
                </label>
                <input
                  id="fifo-dest"
                  type="text"
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                  className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm font-mono text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                />
              </div>
            </div>

            {manualFeedback && (
              <div
                role="status"
                className={`rounded-lg border px-3.5 py-2.5 text-sm flex items-start gap-2 ${
                  manualFeedback.kind === 'success'
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                    : 'border-red-200 bg-red-50 text-red-900'
                }`}
              >
                {manualFeedback.kind === 'success' ? (
                  <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-emerald-700" />
                ) : (
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-red-700" />
                )}
                <span>{manualFeedback.text}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={submittingManual || !preview?.sufficient}
              className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              <Send className="w-4 h-4" />
              <span>{submittingManual ? 'Issuing Stock...' : 'Confirm FIFO Issue'}</span>
            </button>
          </form>

          <div className="lg:col-span-7 rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
              <div>
                <h2 className="text-base font-semibold text-slate-900">FIFO Pick Plan Preview</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Lots ordered oldest receipt timestamp first
                </p>
              </div>
              {preview && (
                <div className="text-right font-mono tabular-nums text-xs">
                  <span
                    className={
                      preview.sufficient ? 'text-emerald-700 font-semibold' : 'text-red-700 font-semibold'
                    }
                  >
                    {preview.sufficient
                      ? `Sufficient (${preview.totalAvailable.toLocaleString()} on hand)`
                      : `Shortfall: ${preview.shortfall.toLocaleString()} units`}
                  </span>
                </div>
              )}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 text-left text-xs font-medium text-slate-500">
                    <th className="px-5 py-2.5">Box ID</th>
                    <th className="px-4 py-2.5">Location</th>
                    <th className="px-4 py-2.5">Received</th>
                    <th className="px-4 py-2.5 text-right">Available</th>
                    <th className="px-4 py-2.5 text-right">Pick Qty</th>
                    <th className="px-5 py-2.5 text-right">Remaining</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {loadingPreview ? (
                    <tr>
                      <td colSpan={6} className="px-5 py-8 text-center text-sm text-slate-500">
                        Calculating FIFO allocation...
                      </td>
                    </tr>
                  ) : !preview || preview.allocations.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-5 py-8 text-center text-sm text-slate-500">
                        Select a part number and positive quantity to preview FIFO lot picks.
                      </td>
                    </tr>
                  ) : (
                    preview.allocations.map((alloc) => (
                      <tr key={alloc.lotId} className="hover:bg-slate-50/80">
                        <td className="px-5 py-3 font-mono font-medium text-slate-900">
                          {alloc.boxId}
                          {alloc.batchRef ? (
                            <span className="block text-[11px] text-slate-500 font-normal">
                              {alloc.batchRef}
                            </span>
                          ) : null}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-slate-700">{alloc.location}</td>
                        <td className="px-4 py-3 font-mono tabular-nums text-xs text-slate-500">
                          {new Date(alloc.receivedAt).toLocaleDateString()}
                        </td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-700">
                          {alloc.availableBefore.toLocaleString()}
                        </td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums font-semibold text-blue-700">
                          -{alloc.takeQty.toLocaleString()}
                        </td>
                        <td className="px-5 py-3 text-right font-mono tabular-nums text-slate-900">
                          {alloc.remainingAfter.toLocaleString()}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
