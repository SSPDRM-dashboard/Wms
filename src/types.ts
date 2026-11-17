export type UserRole = 'admin' | 'supervisor' | 'operator';

export interface AuthUser {
  id?: number | string;
  uid?: string;
  userId?: number | string;
  username: string;
  email?: string;
  fullName: string;
  role: UserRole;
}

export interface Company {
  id: number;
  code: string;
  name: string;
  qr_profile: string;
  description: string;
}

export interface ParsedQrResult {
  valid: boolean;
  companyId: number;
  profile: string;
  rawInput: string;
  cleanedInput: string;
  strippedAimPrefix: string | null;
  kind: 'box_inventory' | 'pallet_reference' | 'packing_list' | 'invalid';
  addsInventory: boolean;
  partNumber: string | null;
  qty: number | null;
  boxId: string | null;
  batchRef: string | null;
  palletRef: string | null;
  items?: Array<{ partNumber: string; qty: number; boxId: string; batchRef: string }>;
  segments: string[];
  message: string;
}

export interface PendingScanItem {
  localId: string;
  partNumber: string;
  qty: number;
  boxId: string;
  batchRef: string;
  palletRef: string;
  location: string;
  rawScan: string;
  scannedAt: string;
}

export interface PendingOutboundItem {
  localId: string;
  lotId: number;
  partNumber: string;
  qty: number;
  availableQty: number;
  boxId: string;
  batchRef: string;
  location: string;
  receivedAt: string;
  rawScan: string;
  scannedAt: string;
  olderFifoNotice: string | null;
}

export interface OutboundScanResponse {
  parsed: ParsedQrResult;
  matchedLot: InventoryLot | null;
  olderFifoLot: {
    id: number;
    box_id: string;
    location: string;
    qty: number;
    received_at: string;
  } | null;
}

export interface ContainerRecord {
  id: number;
  company_id: number;
  container_code: string;
  pallet_ref: string;
  location: string;
  total_boxes: number;
  total_units: number;
  received_by: string;
  completed_at: string;
}

export interface InventoryLot {
  id: number;
  company_id: number;
  part_number: string;
  qty: number;
  initial_qty: number;
  box_id: string;
  batch_ref: string;
  location: string;
  container_id: number | null;
  pallet_ref: string;
  received_at: string;
  container_code?: string | null;
}

export interface SkuSummary {
  part_number: string;
  total_qty: number;
  box_count: number;
  location_count: number;
  oldest_received_at: string;
}

export interface FifoAllocation {
  lotId: number;
  boxId: string;
  batchRef: string;
  location: string;
  receivedAt: string;
  availableBefore: number;
  takeQty: number;
  remainingAfter: number;
}

export interface FifoPreview {
  partNumber: string;
  requestedQty: number;
  totalAvailable: number;
  sufficient: boolean;
  shortfall: number;
  allocations: FifoAllocation[];
}

export interface MovementRecord {
  id: number;
  company_id: number;
  movement_type: 'RECEIVE' | 'OUTBOUND_FIFO' | 'TRANSFER';
  part_number: string;
  qty_delta: number;
  box_id: string;
  batch_ref: string;
  from_location: string;
  to_location: string;
  reference_code: string;
  lot_id: number | null;
  performed_by: string;
  created_at: string;
}

export interface SummaryReport {
  stockTotals: {
    total_units: number;
    active_boxes: number;
    distinct_skus: number;
    active_locations: number;
  };
  containerStats: {
    total_containers: number;
    received_boxes: number;
  };
  movementBreakdown: Array<{
    movement_type: 'RECEIVE' | 'OUTBOUND_FIFO' | 'TRANSFER';
    tx_count: number;
    total_units: number;
  }>;
  byLocation: Array<{
    location: string;
    total_qty: number;
    box_count: number;
    sku_count: number;
  }>;
  topParts: Array<{
    part_number: string;
    total_qty: number;
    box_count: number;
    oldest_lot: string;
  }>;
}

export interface BomItem {
  id: number;
  bom_id: number;
  component_part: string;
  qty_per_assembly: number;
  notes: string;
  available_qty: number;
  buildable_assemblies: number;
}

export interface BomRecord {
  id: number;
  company_id: number;
  parent_part: string;
  description: string;
  revision: string;
  created_by: string;
  updated_at: string;
  max_buildable: number;
  items: BomItem[];
}

export interface UserRecord {
  id: string;
  uid?: string;
  username: string;
  full_name: string;
  role: UserRole;
  active: number;
  created_at: string;
}

export interface UploadedFileRow {
  id: number;
  file_id: number;
  company_id: number;
  lookup_key: string;
  part_name: string;
  part_number: string;
  qty: number;
  batch_ref: string;
}

export const DEFAULT_STORE_FILE_GROUPS = ['B01', 'SAIC', 'M81', 'EC15S'] as const;
export type StoreFileGroup = string;

export function formatStoreGroupLabel(group?: string | null): string {
  if (!group) return '';
  const upper = group.toUpperCase();
  if (upper === 'B01') return '1-B01';
  if (upper === 'SAIC') return '2-SAIC';
  if (upper === 'M81') return '3-M81';
  if (upper === 'EC15S') return '4-EC15S';
  return group;
}

export interface StoreGroupRecord {
  id: string;
  name: string;
  createdByUid: string;
  serverCreatedAt: unknown;
}

export interface UploadedFileRecord {
  id: number;
  company_id: number;
  file_name: string;
  row_count: number;
  uploaded_by: string;
  uploaded_at: string;
  store_group?: StoreFileGroup | '';
  rows: UploadedFileRow[];
}

export interface MasterLookupResponse {
  matched: boolean;
  matchedKey: string | null;
  fileName: string | null;
  storeGroup?: StoreFileGroup | '';
  items: UploadedFileRow[];
}

export type NavSection =
  | 'overview'
  | 'receiving'
  | 'uploaded_files'
  | 'inventory'
  | 'outbound'
  | 'transfer'
  | 'bom'
  | 'movements'
  | 'users';
