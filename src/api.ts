import * as firestoreWms from './firestoreWms';
import type { StoreFileGroup, UserRole } from './types';

export function getStoredToken(): string | null {
  return null;
}

export function setStoredToken(_token: string | null): void {
  // Firebase Auth manages session persistence automatically.
}

export function setUnauthorizedHandler(_fn: () => void): void {
  // Handled via Firebase onAuthStateChanged in App.tsx.
}

export const api = {
  login(username: string, password: string) {
    return firestoreWms.signInWithUsernamePassword(username, password);
  },

  initializeSystemAdmin(payload: { username: string; fullName: string; password: string }) {
    return firestoreWms.initializeSystemAdmin(payload);
  },

  getCompanies() {
    return firestoreWms.getCompanies();
  },

  parseScan(companyId: number, rawScan: string) {
    return firestoreWms.parseScan(companyId, rawScan);
  },

  completeContainer(payload: {
    company_id: number;
    container_code: string;
    pallet_ref: string;
    location: string;
    items: Array<{
      partNumber: string;
      qty: number;
      boxId: string;
      batchRef: string;
      palletRef: string;
      location?: string;
    }>;
  }) {
    return firestoreWms.completeContainer(payload);
  },

  getContainers(companyId: number) {
    return firestoreWms.getContainers(companyId);
  },

  getInventory(companyId: number, search = '', location = '', includeZero = false) {
    return firestoreWms.getInventory(companyId, search, location, includeZero);
  },

  previewOutboundFifo(companyId: number, partNumber: string, qty: number, location = '') {
    return firestoreWms.previewOutboundFifo(companyId, partNumber, qty, location);
  },

  executeOutboundFifo(payload: {
    company_id: number;
    part_number: string;
    qty: number;
    reference_code: string;
    destination: string;
    location?: string;
  }) {
    return firestoreWms.executeOutboundFifo(payload);
  },

  scanOutbound(companyId: number, rawScan: string) {
    return firestoreWms.scanOutbound(companyId, rawScan);
  },

  completeOutbound(payload: {
    company_id: number;
    reference_code: string;
    destination: string;
    pallet_ref: string;
    items: Array<{
      lotId: number;
      boxId: string;
      partNumber: string;
      qty: number;
    }>;
  }) {
    return firestoreWms.completeOutbound(payload);
  },

  transferStock(payload: {
    company_id: number;
    lot_id: number;
    qty: number;
    to_location: string;
    reference_code: string;
  }) {
    return firestoreWms.transferStock(payload);
  },

  getMovements(companyId: number, type = '', search = '') {
    return firestoreWms.getMovements(companyId, type, search);
  },

  getSummaryReport(companyId: number) {
    return firestoreWms.getSummaryReport(companyId);
  },

  getBoms(companyId: number) {
    return firestoreWms.getBoms(companyId);
  },

  saveBom(payload: {
    company_id: number;
    parent_part: string;
    description: string;
    revision: string;
    items: Array<{ component_part: string; qty_per_assembly: number; notes: string }>;
  }) {
    return firestoreWms.saveBom(payload);
  },

  deleteBom(bomId: number) {
    return firestoreWms.deleteBom(bomId);
  },

  getUsers() {
    return firestoreWms.getUsers();
  },

  createUser(payload: {
    username: string;
    full_name: string;
    password: string;
    role: UserRole;
  }) {
    return firestoreWms.createUser(payload);
  },

  updateUser(userId: string | number, payload: { role?: UserRole; active?: number }) {
    return firestoreWms.updateUser(userId, payload);
  },

  getUploadedFiles(companyId: number) {
    return firestoreWms.getUploadedFiles(companyId);
  },

  getAllUploadedFiles() {
    return firestoreWms.getAllUploadedFiles();
  },

  getStoreGroups() {
    return firestoreWms.getStoreGroups();
  },

  createStoreGroup(name: string) {
    return firestoreWms.createStoreGroup(name);
  },

  deleteStoreGroup(groupId: string) {
    return firestoreWms.deleteStoreGroup(groupId);
  },

  uploadMasterFile(payload: {
    company_id: number;
    file_name: string;
    store_group?: StoreFileGroup | '';
    rows: Array<{
      lookup_key: string;
      case_no?: string;
      part_name: string;
      part_number: string;
      qty: number;
      batch_ref: string;
    }>;
  }) {
    return firestoreWms.uploadMasterFile(payload);
  },

  updateUploadedFileGroup(fileId: number, storeGroup: StoreFileGroup | '') {
    return firestoreWms.updateUploadedFileGroup(fileId, storeGroup);
  },

  deleteUploadedFile(fileId: number) {
    return firestoreWms.deleteUploadedFile(fileId);
  },

  lookupUploadedReceiving(companyId: number, rawScan: string, storeGroup?: StoreFileGroup | '') {
    return firestoreWms.lookupUploadedReceiving(companyId, rawScan, storeGroup);
  },
};
