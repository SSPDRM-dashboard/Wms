import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  getDocsFromServer,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  createUserWithEmailAndPassword,
  deleteUser,
  signInWithEmailAndPassword,
  signOut,
  type User as FirebaseUser,
} from 'firebase/auth';
import {
  auth,
  db,
  getSecondaryAuth,
  handleFirestoreError,
  OperationType,
  testConnection,
} from './firebase';
import { parseQrScan } from '../server/qrParser';
import type {
  AuthUser,
  BomItem,
  BomRecord,
  Company,
  ContainerRecord,
  FifoAllocation,
  FifoPreview,
  InventoryLot,
  MasterLookupResponse,
  MovementRecord,
  OutboundScanResponse,
  SkuSummary,
  StoreFileGroup,
  StoreGroupRecord,
  SummaryReport,
  UploadedFileRecord,
  UploadedFileRow,
  UserRecord,
  UserRole,
} from './types';

function normalizeStoreGroup(value: unknown): StoreFileGroup | '' {
  const upper = String(value ?? '').trim().toUpperCase();
  return upper;
}

const BOOTSTRAP_ADMIN_EMAIL = 'leekbmelaka@gmail.com';
const SYSTEM_AUTH_DOMAIN = 'nexuswms.local';

let lastIdSeq = 0;
function nextNumericId(): number {
  const base = Date.now() * 100;
  const next = base <= lastIdSeq ? lastIdSeq + 1 : base;
  lastIdSeq = next;
  return next;
}

function clampStr(val: unknown, maxLen: number): string {
  return String(val ?? '').trim().slice(0, maxLen);
}

function toAuthEmail(usernameInput: string): string {
  const clean = usernameInput.trim().toLowerCase();
  if (clean.length < 2) {
    throw new Error('Username must be at least 2 characters.');
  }
  if (clean.includes('@')) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
      throw new Error('Please enter a valid username or email address.');
    }
    return clean;
  }
  if (!/^[a-z0-9._-]+$/.test(clean)) {
    throw new Error('Username may only contain letters, numbers, dots, underscores, or hyphens.');
  }
  return `${clean}@${SYSTEM_AUTH_DOMAIN}`;
}

function formatUsernameLabel(usernameInput: string): string {
  const trimmed = usernameInput.trim();
  return trimmed.includes('@') ? trimmed.toLowerCase() : trimmed.toLowerCase();
}

function mapFirebaseAuthError(err: unknown, context: 'signin' | 'setup' | 'create_user'): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('auth/operation-not-allowed')) {
    return 'Email/Password sign-in is not yet enabled in Firebase Console. Go to Firebase Console -> Authentication -> Sign-in method -> enable Email/Password for project gen-lang-client-0854843540.';
  }
  if (
    msg.includes('auth/invalid-credential') ||
    msg.includes('auth/wrong-password') ||
    msg.includes('auth/user-not-found')
  ) {
    return 'Invalid username or password.';
  }
  if (msg.includes('auth/email-already-in-use')) {
    return context === 'setup'
      ? 'This username is already registered. Sign in with your password or choose another admin username.'
      : 'This username already exists in the system.';
  }
  if (msg.includes('auth/weak-password')) {
    return 'Password must be at least 6 characters.';
  }
  if (msg.includes('auth/too-many-requests')) {
    return 'Too many failed attempts. Please wait a moment and try again.';
  }
  if (msg.includes('auth/user-disabled')) {
    return 'This account has been disabled in Firebase Authentication.';
  }
  return msg;
}

function requireUid(): { uid: string; actorLabel: string } {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Authentication required. Please sign in.');
  }
  const fallbackName = user.email?.endsWith(`@${SYSTEM_AUTH_DOMAIN}`)
    ? user.email.slice(0, -(`@${SYSTEM_AUTH_DOMAIN}`.length))
    : user.email || user.uid;
  return {
    uid: user.uid,
    actorLabel: clampStr(user.displayName || fallbackName, 120),
  };
}

function isPermissionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('Missing or insufficient permissions') || msg.includes('PERMISSION_DENIED');
}

const inFlightUserSync = new Map<string, Promise<AuthUser>>();
let activeBootstrapPromise: Promise<AuthUser> | null = null;
let inFlightSetup: Promise<void> | null = null;

export function syncSignedInUser(firebaseUser: FirebaseUser): Promise<AuthUser> {
  const existingPromise = inFlightUserSync.get(firebaseUser.uid);
  if (existingPromise) {
    return existingPromise;
  }
  const promise = performSyncSignedInUser(firebaseUser).finally(() => {
    inFlightUserSync.delete(firebaseUser.uid);
  });
  inFlightUserSync.set(firebaseUser.uid, promise);
  return promise;
}

async function performSyncSignedInUser(firebaseUser: FirebaseUser): Promise<AuthUser> {
  if (activeBootstrapPromise) {
    const bootstrapped = await activeBootstrapPromise;
    if (bootstrapped.uid === firebaseUser.uid) {
      return bootstrapped;
    }
  }

  await testConnection();
  const uid = firebaseUser.uid;
  const userPath = `users/${uid}`;
  const userRef = doc(db, 'users', uid);

  let snap;
  try {
    snap = await getDoc(userRef);
  } catch (err) {
    if (isPermissionError(err)) {
      handleFirestoreError(err, OperationType.GET, userPath);
    }
    throw err;
  }

  if (!snap.exists()) {
    throw new Error(
      'Your account is not registered in NexusWMS. Ask an administrator to create your username in User Admin, or use First-Time Admin Setup if the system has not been initialized yet.'
    );
  }

  const data = snap.data() as {
    uid: string;
    username: string;
    full_name: string;
    role: UserRole;
    active: number;
  };

  if (data.active === 0) {
    throw new Error('Your warehouse account has been deactivated. Contact an administrator.');
  }

  return {
    id: uid,
    uid,
    userId: uid,
    username: data.username,
    email: firebaseUser.email || undefined,
    fullName: data.full_name,
    role: data.role,
  };
}

export async function signInWithUsernamePassword(username: string, password: string): Promise<AuthUser> {
  const trimmedUser = username.trim();
  if (!trimmedUser || !password) {
    throw new Error('Username and password are required.');
  }
  const authEmail = toAuthEmail(trimmedUser);

  try {
    const cred = await signInWithEmailAndPassword(auth, authEmail, password);
    return await syncSignedInUser(cred.user);
  } catch (err) {
    throw new Error(mapFirebaseAuthError(err, 'signin'));
  }
}

export function initializeSystemAdmin(payload: {
  username: string;
  fullName: string;
  password: string;
}): Promise<AuthUser> {
  if (activeBootstrapPromise) {
    return activeBootstrapPromise;
  }
  const run = performInitializeSystemAdmin(payload).finally(() => {
    activeBootstrapPromise = null;
  });
  activeBootstrapPromise = run;
  return run;
}

async function performInitializeSystemAdmin(payload: {
  username: string;
  fullName: string;
  password: string;
}): Promise<AuthUser> {
  const cleanUsername = clampStr(formatUsernameLabel(payload.username), 120);
  const cleanFullName = clampStr(payload.fullName, 120);
  const password = payload.password || '';

  if (cleanUsername.length < 2) {
    throw new Error('Admin username must be at least 2 characters.');
  }
  if (!cleanFullName) {
    throw new Error('Full name is required.');
  }
  if (password.length < 6) {
    throw new Error('Password must be at least 6 characters.');
  }

  const authEmail = toAuthEmail(cleanUsername);

  let cred;
  try {
    cred = await createUserWithEmailAndPassword(auth, authEmail, password);
  } catch (err) {
    throw new Error(mapFirebaseAuthError(err, 'setup'));
  }

  const uid = cred.user.uid;
  const nowIso = new Date().toISOString();

  try {
    const bootSnap = await getDoc(doc(db, 'system', 'bootstrap'));
    if (bootSnap.exists()) {
      try {
        await deleteUser(cred.user);
      } catch {
        await signOut(auth);
      }
      throw new Error(
        'System administrator is already initialized. Please sign in with your username and password.'
      );
    }

    const batch = writeBatch(db);
    batch.set(doc(db, 'system', 'bootstrap'), {
      initialized: true,
      adminUid: uid,
      createdAt: serverTimestamp(),
    });
    batch.set(doc(db, 'users', uid), {
      uid,
      username: cleanUsername,
      full_name: cleanFullName,
      role: 'admin' as UserRole,
      active: 1,
      created_at: nowIso,
      createdByUid: uid,
      serverCreatedAt: serverTimestamp(),
    });
    batch.set(doc(db, 'admins', uid), {
      uid,
      email: clampStr(authEmail, 160),
      grantedAt: serverTimestamp(),
    });
    await batch.commit();

    await ensureInitialSetup();

    return {
      id: uid,
      uid,
      userId: uid,
      username: cleanUsername,
      email: authEmail,
      fullName: cleanFullName,
      role: 'admin',
    };
  } catch (err) {
    try {
      await deleteUser(cred.user);
    } catch {
      try {
        await signOut(auth);
      } catch {
        // Ignore sign-out errors
      }
    }
    if (isPermissionError(err)) {
      throw new Error(
        'System administrator is already initialized or initialization is not permitted. Please sign in with an existing account.'
      );
    }
    throw err;
  }
}

export function ensureInitialSetup(): Promise<void> {
  if (inFlightSetup) {
    return inFlightSetup;
  }
  inFlightSetup = performInitialSetup().finally(() => {
    inFlightSetup = null;
  });
  return inFlightSetup;
}

async function performInitialSetup(): Promise<void> {
  const path = 'companies';
  try {
    const q = query(collection(db, 'companies'), where('id', 'in', [1, 2]));
    const snap = await getDocs(q);
    const existingIds = new Set(snap.docs.map((d) => Number(d.data().id)));

    if (existingIds.has(1) && existingIds.has(2)) {
      return;
    }

    const batch = writeBatch(db);
    if (!existingIds.has(1)) {
      batch.set(doc(db, 'companies', '1'), {
        id: 1,
        code: 'COMP-B-SAIC',
        name: 'COMP-B-SAIC',
        qr_profile: 'underscore_v1',
        description: 'Underscore-delimited QR profile: seg 2 = part, seg 4 = qty, seg 5 = box, seg 6 = batch',
      });
    }
    if (!existingIds.has(2)) {
      batch.set(doc(db, 'companies', '2'), {
        id: 2,
        code: 'COMP-A-GWM',
        name: 'COMP-A-GWM',
        qr_profile: 'slash_box_pallet_v1',
        description: 'Slash-delimited box QR (seg 2 = part&qty, seg 3 = batch, seg 4 = box) + pallet reference QR',
      });
    }
    await batch.commit();
  } catch (err) {
    if (isPermissionError(err)) {
      handleFirestoreError(err, OperationType.WRITE, path);
    }
    throw err;
  }
}

export async function getCompanies(): Promise<{ companies: Company[] }> {
  const path = 'companies';
  try {
    const q = query(collection(db, 'companies'), where('id', 'in', [1, 2]));
    const snap = await getDocs(q);
    const companies = snap.docs
      .map((d) => d.data() as Company)
      .sort((a, b) => a.id - b.id);
    return { companies };
  } catch (err) {
    if (isPermissionError(err)) {
      handleFirestoreError(err, OperationType.LIST, path);
    }
    throw err;
  }
}

export function parseScan(companyId: number, rawScan: string) {
  return Promise.resolve(parseQrScan(companyId, rawScan));
}

export async function completeContainer(payload: {
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
  const { uid, actorLabel } = requireUid();
  const companyId = Number(payload.company_id);
  const containerCode = clampStr(payload.container_code, 120);
  const palletRef = clampStr(payload.pallet_ref, 120);
  const defaultLoc = clampStr(payload.location, 120) || 'RCV-DOCK-01';
  const items = Array.isArray(payload.items) ? payload.items : [];

  if (!companyId || !containerCode) {
    throw new Error('company_id and container_code are required.');
  }
  if (items.length === 0) {
    throw new Error('At least one staged box scan is required to complete a container.');
  }

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it?.partNumber || !it?.boxId || !Number.isInteger(Number(it.qty)) || Number(it.qty) <= 0) {
      throw new Error(`Invalid item at row ${i + 1}: partNumber, boxId, and positive integer qty are required.`);
    }
  }

  const nowIso = new Date().toISOString();
  const containerId = nextNumericId();
  let totalUnits = 0;
  const distinctLocations = new Set<string>();

  for (const it of items) {
    totalUnits += Number(it.qty);
    distinctLocations.add(clampStr(it.location, 120) || defaultLoc);
  }

  const containerLocationSummary = clampStr(
    distinctLocations.size === 1
      ? Array.from(distinctLocations)[0]
      : `${defaultLoc} (${distinctLocations.size} bins)`,
    120
  );

  try {
    const CHUNK = 200; // 2 writes per item = 400 ops (< 500 Firestore batch limit)
    for (let start = 0; start < items.length; start += CHUNK) {
      const batch = writeBatch(db);
      if (start === 0) {
        batch.set(doc(db, 'containers', String(containerId)), {
          id: containerId,
          company_id: companyId,
          container_code: containerCode,
          pallet_ref: palletRef,
          location: containerLocationSummary,
          total_boxes: items.length,
          total_units: totalUnits,
          received_by: actorLabel,
          completed_at: nowIso,
          createdByUid: uid,
          serverCreatedAt: serverTimestamp(),
        });
      }

      const slice = items.slice(start, start + CHUNK);
      for (const item of slice) {
        const lotId = nextNumericId();
        const moveId = nextNumericId();
        const qty = Number(item.qty);
        const partNumber = clampStr(item.partNumber, 120);
        const boxId = clampStr(item.boxId, 120);
        const batchRef = clampStr(item.batchRef, 120);
        const itemPalletRef = clampStr(item.palletRef || palletRef, 120);
        const itemLocation = clampStr(item.location, 120) || defaultLoc;

        batch.set(doc(db, 'inventory_lots', String(lotId)), {
          id: lotId,
          company_id: companyId,
          part_number: partNumber,
          qty,
          initial_qty: qty,
          box_id: boxId,
          batch_ref: batchRef,
          location: itemLocation,
          container_id: containerId,
          container_code: containerCode,
          pallet_ref: itemPalletRef,
          received_at: nowIso,
          createdByUid: uid,
          serverCreatedAt: serverTimestamp(),
          serverUpdatedAt: serverTimestamp(),
        });

        batch.set(doc(db, 'movements', String(moveId)), {
          id: moveId,
          company_id: companyId,
          movement_type: 'RECEIVE',
          part_number: partNumber,
          qty_delta: qty,
          box_id: boxId,
          batch_ref: batchRef,
          from_location: 'INBOUND',
          to_location: itemLocation,
          reference_code: containerCode,
          lot_id: lotId,
          performed_by: actorLabel,
          created_at: nowIso,
          createdByUid: uid,
          serverCreatedAt: serverTimestamp(),
        });
      }

      await batch.commit();
    }

    return {
      containerId,
      containerCode,
      totalBoxes: items.length,
      totalUnits,
      location: containerLocationSummary,
      completedAt: nowIso,
    };
  } catch (err) {
    if (isPermissionError(err)) {
      handleFirestoreError(err, OperationType.WRITE, 'containers');
    }
    throw err;
  }
}

export async function getContainers(companyId: number): Promise<{ containers: ContainerRecord[] }> {
  const path = 'containers';
  try {
    const q = query(collection(db, 'containers'), where('company_id', '==', Number(companyId)));
    const snap = await getDocs(q);
    const containers = snap.docs
      .map((d) => d.data() as ContainerRecord)
      .sort((a, b) => b.completed_at.localeCompare(a.completed_at) || b.id - a.id)
      .slice(0, 25);
    return { containers };
  } catch (err) {
    if (isPermissionError(err)) {
      handleFirestoreError(err, OperationType.LIST, path);
    }
    throw err;
  }
}

async function fetchCompanyLots(companyId: number): Promise<InventoryLot[]> {
  const path = 'inventory_lots';
  try {
    const q = query(collection(db, 'inventory_lots'), where('company_id', '==', Number(companyId)));
    const snap = await getDocs(q);
    return snap.docs
      .map((d) => d.data() as InventoryLot)
      .sort((a, b) => a.received_at.localeCompare(b.received_at) || a.id - b.id);
  } catch (err) {
    if (isPermissionError(err)) {
      handleFirestoreError(err, OperationType.LIST, path);
    }
    throw err;
  }
}

export async function getInventory(
  companyId: number,
  search = '',
  location = '',
  includeZero = false
): Promise<{
  lots: InventoryLot[];
  skuSummary: SkuSummary[];
  locations: string[];
}> {
  const allLots = await fetchCompanyLots(companyId);
  const searchLower = search.trim().toLowerCase();
  const locTrim = location.trim();

  const lots = allLots.filter((l) => {
    if (!includeZero && l.qty <= 0) return false;
    if (locTrim && l.location !== locTrim) return false;
    if (searchLower) {
      const hay = [l.part_number, l.box_id, l.batch_ref, l.location, l.pallet_ref]
        .join(' ')
        .toLowerCase();
      if (!hay.includes(searchLower)) return false;
    }
    return true;
  });

  const summaryMap = new Map<
    string,
    { part_number: string; total_qty: number; box_count: number; locs: Set<string>; oldest_received_at: string }
  >();

  for (const l of lots) {
    const existing = summaryMap.get(l.part_number);
    if (!existing) {
      summaryMap.set(l.part_number, {
        part_number: l.part_number,
        total_qty: l.qty,
        box_count: 1,
        locs: new Set([l.location]),
        oldest_received_at: l.received_at,
      });
    } else {
      existing.total_qty += l.qty;
      existing.box_count += 1;
      existing.locs.add(l.location);
      if (l.received_at < existing.oldest_received_at) {
        existing.oldest_received_at = l.received_at;
      }
    }
  }

  const skuSummary: SkuSummary[] = Array.from(summaryMap.values())
    .map((s) => ({
      part_number: s.part_number,
      total_qty: s.total_qty,
      box_count: s.box_count,
      location_count: s.locs.size,
      oldest_received_at: s.oldest_received_at,
    }))
    .sort((a, b) => a.part_number.localeCompare(b.part_number));

  const locations = Array.from(
    new Set(allLots.filter((l) => l.qty > 0).map((l) => l.location))
  ).sort((a, b) => a.localeCompare(b));

  return { lots, skuSummary, locations };
}

function buildFifoAllocations(
  lots: InventoryLot[],
  requestedQty: number
): {
  totalAvailable: number;
  sufficient: boolean;
  shortfall: number;
  allocations: FifoAllocation[];
} {
  let remaining = requestedQty;
  let totalAvailable = 0;
  const allocations: FifoAllocation[] = [];

  for (const lot of lots) {
    totalAvailable += lot.qty;
    if (remaining > 0) {
      const takeQty = Math.min(lot.qty, remaining);
      allocations.push({
        lotId: lot.id,
        boxId: lot.box_id,
        batchRef: lot.batch_ref,
        location: lot.location,
        receivedAt: lot.received_at,
        availableBefore: lot.qty,
        takeQty,
        remainingAfter: lot.qty - takeQty,
      });
      remaining -= takeQty;
    }
  }

  return {
    totalAvailable,
    sufficient: remaining === 0,
    shortfall: Math.max(0, remaining),
    allocations,
  };
}

export async function previewOutboundFifo(
  companyId: number,
  partNumber: string,
  qty: number,
  location = ''
): Promise<FifoPreview> {
  const allLots = await fetchCompanyLots(companyId);
  const targetPart = partNumber.trim();
  const targetLoc = location.trim();

  const matching = allLots.filter(
    (l) => l.qty > 0 && l.part_number === targetPart && (!targetLoc || l.location === targetLoc)
  );
  const plan = buildFifoAllocations(matching, Number(qty));

  return {
    partNumber: targetPart,
    requestedQty: Number(qty),
    ...plan,
  };
}

export async function executeOutboundFifo(payload: {
  company_id: number;
  part_number: string;
  qty: number;
  reference_code: string;
  destination: string;
  location?: string;
}) {
  const { uid, actorLabel } = requireUid();
  const companyId = Number(payload.company_id);
  const partNumber = clampStr(payload.part_number, 120);
  const requestedQty = Number(payload.qty);
  const referenceCode = clampStr(payload.reference_code, 120) || `OUT-${Date.now()}`;
  const destination = clampStr(payload.destination, 120) || 'PRODUCTION';
  const loc = clampStr(payload.location, 120);

  if (!companyId || !partNumber || !Number.isInteger(requestedQty) || requestedQty <= 0) {
    throw new Error('Valid company_id, part_number, and positive integer qty are required.');
  }

  const preview = await previewOutboundFifo(companyId, partNumber, requestedQty, loc);
  if (!preview.sufficient) {
    throw new Error(
      `Insufficient stock for ${partNumber}. Requested ${requestedQty}, available ${preview.totalAvailable}.`
    );
  }

  const nowIso = new Date().toISOString();

  try {
    const finalAllocations = await runTransaction(db, async (tx) => {
      const lotSnaps = await Promise.all(
        preview.allocations.map((alloc) => tx.get(doc(db, 'inventory_lots', String(alloc.lotId))))
      );

      let remaining = requestedQty;
      const committed: FifoAllocation[] = [];

      for (const snap of lotSnaps) {
        if (!snap.exists()) {
          throw new Error('Selected inventory lot no longer exists. Please refresh and retry.');
        }
        const lot = snap.data() as InventoryLot;
        if (lot.qty <= 0 || remaining <= 0) continue;

        const takeQty = Math.min(lot.qty, remaining);
        const remainingAfter = lot.qty - takeQty;
        tx.update(snap.ref, {
          qty: remainingAfter,
          serverUpdatedAt: serverTimestamp(),
        });

        const moveId = nextNumericId();
        tx.set(doc(db, 'movements', String(moveId)), {
          id: moveId,
          company_id: companyId,
          movement_type: 'OUTBOUND_FIFO',
          part_number: lot.part_number,
          qty_delta: -takeQty,
          box_id: lot.box_id,
          batch_ref: lot.batch_ref || '',
          from_location: lot.location,
          to_location: destination,
          reference_code: referenceCode,
          lot_id: lot.id,
          performed_by: actorLabel,
          created_at: nowIso,
          createdByUid: uid,
          serverCreatedAt: serverTimestamp(),
        });

        committed.push({
          lotId: lot.id,
          boxId: lot.box_id,
          batchRef: lot.batch_ref,
          location: lot.location,
          receivedAt: lot.received_at,
          availableBefore: lot.qty,
          takeQty,
          remainingAfter,
        });

        remaining -= takeQty;
      }

      if (remaining > 0) {
        throw new Error('Stock changed concurrently during FIFO issue. Please retry.');
      }
      return committed;
    });

    return {
      partNumber,
      issuedQty: requestedQty,
      referenceCode,
      destination,
      allocations: finalAllocations,
      issuedAt: nowIso,
    };
  } catch (err) {
    if (isPermissionError(err)) {
      handleFirestoreError(err, OperationType.UPDATE, 'inventory_lots');
    }
    throw err;
  }
}

export async function scanOutbound(companyId: number, rawScan: string): Promise<OutboundScanResponse> {
  const parsed = parseQrScan(companyId, rawScan);
  if (!parsed.valid || parsed.kind !== 'box_inventory' || !parsed.boxId) {
    return {
      parsed,
      matchedLot: null,
      olderFifoLot: null,
    };
  }

  const allLots = await fetchCompanyLots(companyId);
  const activeLots = allLots.filter((l) => l.qty > 0);
  const targetBoxLower = parsed.boxId.toLowerCase();

  const matchedLot =
    activeLots.find(
      (l) =>
        l.box_id.toLowerCase() === targetBoxLower &&
        (!parsed.partNumber || l.part_number.toLowerCase() === parsed.partNumber.toLowerCase())
    ) ||
    activeLots.find((l) => l.box_id.toLowerCase() === targetBoxLower) ||
    null;

  if (!matchedLot) {
    return {
      parsed,
      matchedLot: null,
      olderFifoLot: null,
    };
  }

  const older = activeLots.find(
    (l) =>
      l.part_number === matchedLot.part_number &&
      l.id !== matchedLot.id &&
      (l.received_at < matchedLot.received_at ||
        (l.received_at === matchedLot.received_at && l.id < matchedLot.id))
  );

  return {
    parsed,
    matchedLot,
    olderFifoLot: older
      ? {
          id: older.id,
          box_id: older.box_id,
          location: older.location,
          qty: older.qty,
          received_at: older.received_at,
        }
      : null,
  };
}

export async function completeOutbound(payload: {
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
  const { uid, actorLabel } = requireUid();
  const companyId = Number(payload.company_id);
  const referenceCode = clampStr(payload.reference_code, 120) || `OUT-${Date.now()}`;
  const destination = clampStr(payload.destination, 120) || 'SHIPPING-DOCK';
  const palletRef = clampStr(payload.pallet_ref, 120);
  const items = Array.isArray(payload.items) ? payload.items : [];

  if (!companyId || items.length === 0) {
    throw new Error('company_id and at least one scanned box are required.');
  }

  const nowIso = new Date().toISOString();

  try {
    const totalUnits = await runTransaction(db, async (tx) => {
      const snaps = await Promise.all(
        items.map((it) => tx.get(doc(db, 'inventory_lots', String(it.lotId))))
      );

      let sumUnits = 0;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const snap = snaps[i];
        if (!snap.exists()) {
          throw new Error(`Lot for box "${item.boxId}" no longer exists.`);
        }
        const lot = snap.data() as InventoryLot;
        const issueQty = Number(item.qty);
        if (!Number.isInteger(issueQty) || issueQty <= 0) {
          throw new Error(`Invalid issue quantity for box "${item.boxId}".`);
        }
        if (lot.company_id !== companyId) {
          throw new Error(`Lot ${lot.id} does not belong to company ${companyId}.`);
        }
        if (lot.qty < issueQty) {
          throw new Error(
            `Box "${lot.box_id}" only has ${lot.qty} units available (requested ${issueQty}).`
          );
        }

        tx.update(snap.ref, {
          qty: lot.qty - issueQty,
          serverUpdatedAt: serverTimestamp(),
        });

        const moveId = nextNumericId();
        tx.set(doc(db, 'movements', String(moveId)), {
          id: moveId,
          company_id: companyId,
          movement_type: 'OUTBOUND_FIFO',
          part_number: lot.part_number,
          qty_delta: -issueQty,
          box_id: lot.box_id,
          batch_ref: lot.batch_ref || '',
          from_location: lot.location,
          to_location: destination,
          reference_code: palletRef ? `${referenceCode} · ${palletRef}`.slice(0, 120) : referenceCode,
          lot_id: lot.id,
          performed_by: actorLabel,
          created_at: nowIso,
          createdByUid: uid,
          serverCreatedAt: serverTimestamp(),
        });

        sumUnits += issueQty;
      }

      return sumUnits;
    });

    return {
      referenceCode,
      destination,
      palletRef,
      totalBoxes: items.length,
      totalUnits,
      issuedAt: nowIso,
    };
  } catch (err) {
    if (isPermissionError(err)) {
      handleFirestoreError(err, OperationType.UPDATE, 'inventory_lots');
    }
    throw err;
  }
}

export async function transferStock(payload: {
  company_id: number;
  lot_id: number;
  qty: number;
  to_location: string;
  reference_code: string;
}) {
  const { uid, actorLabel } = requireUid();
  const companyId = Number(payload.company_id);
  const lotId = Number(payload.lot_id);
  const qty = Number(payload.qty);
  const toLocation = clampStr(payload.to_location, 120);
  const referenceCode = clampStr(payload.reference_code, 120) || `TRF-${Date.now()}`;

  if (!companyId || !lotId || !Number.isInteger(qty) || qty <= 0 || !toLocation) {
    throw new Error('company_id, lot_id, positive integer qty, and to_location are required.');
  }

  const nowIso = new Date().toISOString();

  try {
    return await runTransaction(db, async (tx) => {
      const lotRef = doc(db, 'inventory_lots', String(lotId));
      const snap = await tx.get(lotRef);
      if (!snap.exists()) {
        throw new Error('Inventory lot not found.');
      }
      const lot = snap.data() as InventoryLot;
      if (lot.company_id !== companyId) {
        throw new Error('Lot does not belong to the selected company.');
      }
      if (lot.qty < qty) {
        throw new Error(`Transfer qty (${qty}) exceeds available lot qty (${lot.qty}).`);
      }
      if (lot.location === toLocation) {
        throw new Error('Destination location must differ from current location.');
      }

      const fromLocation = lot.location;
      let targetLotId = lot.id;

      if (qty === lot.qty) {
        tx.update(lotRef, {
          location: toLocation,
          serverUpdatedAt: serverTimestamp(),
        });
      } else {
        tx.update(lotRef, {
          qty: lot.qty - qty,
          serverUpdatedAt: serverTimestamp(),
        });

        targetLotId = nextNumericId();
        tx.set(doc(db, 'inventory_lots', String(targetLotId)), {
          id: targetLotId,
          company_id: companyId,
          part_number: lot.part_number,
          qty,
          initial_qty: qty,
          box_id: lot.box_id,
          batch_ref: lot.batch_ref || '',
          location: toLocation,
          container_id: lot.container_id ?? 0,
          container_code: lot.container_code || '',
          pallet_ref: lot.pallet_ref || '',
          received_at: lot.received_at,
          createdByUid: uid,
          serverCreatedAt: serverTimestamp(),
          serverUpdatedAt: serverTimestamp(),
        });
      }

      const moveId = nextNumericId();
      tx.set(doc(db, 'movements', String(moveId)), {
        id: moveId,
        company_id: companyId,
        movement_type: 'TRANSFER',
        part_number: lot.part_number,
        qty_delta: qty,
        box_id: lot.box_id,
        batch_ref: lot.batch_ref || '',
        from_location: fromLocation,
        to_location: toLocation,
        reference_code: referenceCode,
        lot_id: targetLotId,
        performed_by: actorLabel,
        created_at: nowIso,
        createdByUid: uid,
        serverCreatedAt: serverTimestamp(),
      });

      return {
        lotId: targetLotId,
        partNumber: lot.part_number,
        boxId: lot.box_id,
        qtyTransferred: qty,
        fromLocation,
        toLocation,
        transferredAt: nowIso,
      };
    });
  } catch (err) {
    if (isPermissionError(err)) {
      handleFirestoreError(err, OperationType.UPDATE, `inventory_lots/${lotId}`);
    }
    throw err;
  }
}

export async function getMovements(
  companyId: number,
  type = '',
  search = ''
): Promise<{ movements: MovementRecord[] }> {
  const path = 'movements';
  try {
    const q = query(collection(db, 'movements'), where('company_id', '==', Number(companyId)));
    const snap = await getDocs(q);
    const searchLower = search.trim().toLowerCase();

    const movements = snap.docs
      .map((d) => d.data() as MovementRecord)
      .filter((m) => {
        if (type && ['RECEIVE', 'OUTBOUND_FIFO', 'TRANSFER'].includes(type) && m.movement_type !== type) {
          return false;
        }
        if (searchLower) {
          const hay = [
            m.part_number,
            m.box_id,
            m.batch_ref,
            m.reference_code,
            m.from_location,
            m.to_location,
          ]
            .join(' ')
            .toLowerCase();
          if (!hay.includes(searchLower)) return false;
        }
        return true;
      })
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)
      .slice(0, 200);

    return { movements };
  } catch (err) {
    if (isPermissionError(err)) {
      handleFirestoreError(err, OperationType.LIST, path);
    }
    throw err;
  }
}

export async function getSummaryReport(companyId: number): Promise<SummaryReport> {
  const [lots, containersRes, movementsRes] = await Promise.all([
    fetchCompanyLots(companyId),
    getContainers(companyId),
    getMovements(companyId),
  ]);

  const activeLots = lots.filter((l) => l.qty > 0);
  const totalUnits = activeLots.reduce((sum, l) => sum + l.qty, 0);
  const distinctSkus = new Set(activeLots.map((l) => l.part_number)).size;
  const activeLocations = new Set(activeLots.map((l) => l.location)).size;

  const containers = containersRes.containers;
  const receivedBoxes = containers.reduce((sum, c) => sum + (c.total_boxes || 0), 0);

  const movMap = new Map<
    'RECEIVE' | 'OUTBOUND_FIFO' | 'TRANSFER',
    { movement_type: 'RECEIVE' | 'OUTBOUND_FIFO' | 'TRANSFER'; tx_count: number; total_units: number }
  >();
  for (const m of movementsRes.movements) {
    const cur = movMap.get(m.movement_type) || {
      movement_type: m.movement_type,
      tx_count: 0,
      total_units: 0,
    };
    cur.tx_count += 1;
    cur.total_units += Math.abs(m.qty_delta);
    movMap.set(m.movement_type, cur);
  }

  const locMap = new Map<
    string,
    { location: string; total_qty: number; box_count: number; skus: Set<string> }
  >();
  const partMap = new Map<
    string,
    { part_number: string; total_qty: number; box_count: number; oldest_lot: string }
  >();

  for (const l of activeLots) {
    const locEntry = locMap.get(l.location) || {
      location: l.location,
      total_qty: 0,
      box_count: 0,
      skus: new Set<string>(),
    };
    locEntry.total_qty += l.qty;
    locEntry.box_count += 1;
    locEntry.skus.add(l.part_number);
    locMap.set(l.location, locEntry);

    const partEntry = partMap.get(l.part_number) || {
      part_number: l.part_number,
      total_qty: 0,
      box_count: 0,
      oldest_lot: l.received_at,
    };
    partEntry.total_qty += l.qty;
    partEntry.box_count += 1;
    if (l.received_at < partEntry.oldest_lot) partEntry.oldest_lot = l.received_at;
    partMap.set(l.part_number, partEntry);
  }

  const byLocation = Array.from(locMap.values())
    .map((entry) => ({
      location: entry.location,
      total_qty: entry.total_qty,
      box_count: entry.box_count,
      sku_count: entry.skus.size,
    }))
    .sort((a, b) => b.total_qty - a.total_qty);

  const topParts = Array.from(partMap.values())
    .sort((a, b) => b.total_qty - a.total_qty)
    .slice(0, 10);

  return {
    stockTotals: {
      total_units: totalUnits,
      active_boxes: activeLots.length,
      distinct_skus: distinctSkus,
      active_locations: activeLocations,
    },
    containerStats: {
      total_containers: containers.length,
      received_boxes: receivedBoxes,
    },
    movementBreakdown: Array.from(movMap.values()),
    byLocation,
    topParts,
  };
}

export async function getBoms(companyId: number): Promise<{ boms: BomRecord[] }> {
  const path = 'boms';
  try {
    const [bomSnap, lots] = await Promise.all([
      getDocs(query(collection(db, 'boms'), where('company_id', '==', Number(companyId)))),
      fetchCompanyLots(companyId),
    ]);

    const stockMap = new Map<string, number>();
    for (const l of lots) {
      if (l.qty > 0) {
        stockMap.set(l.part_number, (stockMap.get(l.part_number) || 0) + l.qty);
      }
    }

    const bomHeaders = bomSnap.docs
      .map((d) => d.data() as Omit<BomRecord, 'max_buildable' | 'items'>)
      .sort((a, b) => a.parent_part.localeCompare(b.parent_part));

    const itemSnaps = await Promise.all(
      bomHeaders.map((bom) =>
        getDocs(
          query(
            collection(db, 'boms', String(bom.id), 'items'),
            where('company_id', '==', Number(companyId))
          )
        )
      )
    );

    const boms: BomRecord[] = bomHeaders.map((bom, idx) => {
      const rawItems = itemSnaps[idx].docs
        .map((d) => d.data() as Omit<BomItem, 'available_qty' | 'buildable_assemblies'>)
        .sort((a, b) => a.id - b.id);

      let maxBuildable = rawItems.length > 0 ? Infinity : 0;
      const items: BomItem[] = rawItems.map((it) => {
        const availableQty = stockMap.get(it.component_part) ?? 0;
        const buildable = Math.floor(availableQty / it.qty_per_assembly);
        if (buildable < maxBuildable) maxBuildable = buildable;
        return {
          ...it,
          available_qty: availableQty,
          buildable_assemblies: buildable,
        };
      });

      return {
        ...bom,
        max_buildable: maxBuildable === Infinity ? 0 : maxBuildable,
        items,
      };
    });

    return { boms };
  } catch (err) {
    if (isPermissionError(err)) {
      handleFirestoreError(err, OperationType.LIST, path);
    }
    throw err;
  }
}

export async function saveBom(payload: {
  company_id: number;
  parent_part: string;
  description: string;
  revision: string;
  items: Array<{ component_part: string; qty_per_assembly: number; notes: string }>;
}) {
  const { uid, actorLabel } = requireUid();
  const companyId = Number(payload.company_id);
  const parentPart = clampStr(payload.parent_part, 120);
  const description = clampStr(payload.description, 300);
  const revision = clampStr(payload.revision, 32) || 'A';
  const items = Array.isArray(payload.items) ? payload.items : [];

  if (!companyId || !parentPart || items.length === 0) {
    throw new Error('company_id, parent_part, and at least one component line are required.');
  }

  for (const it of items) {
    if (!it.component_part || !Number.isInteger(Number(it.qty_per_assembly)) || Number(it.qty_per_assembly) <= 0) {
      throw new Error('Each BOM component requires component_part and positive integer qty_per_assembly.');
    }
  }

  const nowIso = new Date().toISOString();

  try {
    const existingSnap = await getDocs(
      query(
        collection(db, 'boms'),
        where('company_id', '==', companyId),
        where('parent_part', '==', parentPart)
      )
    );

    const existingDoc = existingSnap.docs[0];
    const bomId = existingDoc ? Number(existingDoc.data().id) : nextNumericId();
    const bomRef = doc(db, 'boms', String(bomId));

    const batch = writeBatch(db);
    if (existingDoc) {
      batch.update(bomRef, {
        description,
        revision,
        created_by: actorLabel,
        updated_at: nowIso,
        serverUpdatedAt: serverTimestamp(),
      });

      const oldItemsSnap = await getDocs(
        query(collection(db, 'boms', String(bomId), 'items'), where('company_id', '==', companyId))
      );
      for (const oldDoc of oldItemsSnap.docs) {
        batch.delete(oldDoc.ref);
      }
    } else {
      batch.set(bomRef, {
        id: bomId,
        company_id: companyId,
        parent_part: parentPart,
        description,
        revision,
        created_by: actorLabel,
        updated_at: nowIso,
        createdByUid: uid,
        serverCreatedAt: serverTimestamp(),
        serverUpdatedAt: serverTimestamp(),
      });
    }

    for (const it of items) {
      const itemId = nextNumericId();
      batch.set(doc(db, 'boms', String(bomId), 'items', String(itemId)), {
        id: itemId,
        bom_id: bomId,
        company_id: companyId,
        component_part: clampStr(it.component_part, 120),
        qty_per_assembly: Number(it.qty_per_assembly),
        notes: clampStr(it.notes, 250),
        createdByUid: uid,
      });
    }

    await batch.commit();
    return { id: bomId, parent_part: parentPart, revision };
  } catch (err) {
    if (isPermissionError(err)) {
      handleFirestoreError(err, OperationType.WRITE, 'boms');
    }
    throw err;
  }
}

export async function deleteBom(bomId: number) {
  const path = `boms/${bomId}`;
  try {
    const bomRef = doc(db, 'boms', String(bomId));
    const snap = await getDoc(bomRef);
    if (!snap.exists()) {
      throw new Error('BOM not found.');
    }
    const companyId = Number(snap.data().company_id);
    const itemsSnap = await getDocs(
      query(collection(db, 'boms', String(bomId), 'items'), where('company_id', '==', companyId))
    );

    const batch = writeBatch(db);
    for (const itemDoc of itemsSnap.docs) {
      batch.delete(itemDoc.ref);
    }
    batch.delete(bomRef);
    await batch.commit();
    return { deleted: true, id: bomId };
  } catch (err) {
    if (isPermissionError(err)) {
      handleFirestoreError(err, OperationType.DELETE, path);
    }
    throw err;
  }
}



export async function getStoreGroups(): Promise<StoreGroupRecord[]> {
  const path = 'store_groups';
  try {
    const snap = await getDocsFromServer(collection(db, 'store_groups')).catch(() =>
      getDocs(collection(db, 'store_groups'))
    );
    return snap.docs.map((d) => d.data() as StoreGroupRecord);
  } catch (err) {
    if (isPermissionError(err)) {
      handleFirestoreError(err, OperationType.LIST, path);
    }
    return [];
  }
}

export async function createStoreGroup(nameInput: string): Promise<StoreGroupRecord> {
  const { uid } = requireUid();
  const name = clampStr(nameInput.trim(), 32);
  if (!name) {
    throw new Error('Group name is required.');
  }
  const id = name.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_\-]+/g, '').toUpperCase();
  if (!id) {
    throw new Error('Invalid group name.');
  }

  const groupRef = doc(db, 'store_groups', id);
  const path = `store_groups/${id}`;

  const record: StoreGroupRecord = {
    id,
    name,
    createdByUid: uid,
    serverCreatedAt: serverTimestamp(),
  };

  try {
    await setDoc(groupRef, record);
    return record;
  } catch (err) {
    if (isPermissionError(err)) {
      handleFirestoreError(err, OperationType.WRITE, path);
    }
    throw err;
  }
}

export async function deleteStoreGroup(groupId: string): Promise<{ id: string }> {
  requireUid();
  const path = `store_groups/${groupId}`;
  try {
    await deleteDoc(doc(db, 'store_groups', groupId));
    return { id: groupId };
  } catch (err) {
    if (isPermissionError(err)) {
      handleFirestoreError(err, OperationType.DELETE, path);
    }
    throw err;
  }
}

async function fetchUploadedFilesInternal(companyId?: number): Promise<{ files: UploadedFileRecord[] }> {
  const path = 'uploaded_files';
  try {
    const q =
      typeof companyId === 'number'
        ? query(collection(db, 'uploaded_files'), where('company_id', '==', Number(companyId)))
        : query(collection(db, 'uploaded_files'), where('company_id', 'in', [1, 2]));

    const snap = await getDocsFromServer(q);
    const headers = snap.docs
      .map((d) => d.data() as Omit<UploadedFileRecord, 'rows'>)
      .sort((a, b) => b.id - a.id);

    const rowResults = await Promise.allSettled(
      headers.map((file) =>
        getDocsFromServer(
          query(
            collection(db, 'uploaded_files', String(file.id), 'rows'),
            where('company_id', '==', Number(file.company_id))
          )
        )
      )
    );

    const files: UploadedFileRecord[] = headers.map((file, idx) => {
      const res = rowResults[idx];
      const rows =
        res.status === 'fulfilled'
          ? res.value.docs.map((d) => d.data() as UploadedFileRow).sort((a, b) => a.id - b.id)
          : [];
      return {
        ...file,
        store_group: normalizeStoreGroup((file as { store_group?: unknown }).store_group),
        rows,
      };
    });

    return { files };
  } catch (err) {
    if (isPermissionError(err)) {
      handleFirestoreError(err, OperationType.LIST, path);
    }
    throw err;
  }
}

export function getUploadedFiles(companyId: number): Promise<{ files: UploadedFileRecord[] }> {
  return fetchUploadedFilesInternal(Number(companyId));
}

export function getAllUploadedFiles(): Promise<{ files: UploadedFileRecord[] }> {
  return fetchUploadedFilesInternal();
}

export async function uploadMasterFile(payload: {
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
}): Promise<{ file: UploadedFileRecord }> {
  const { uid, actorLabel } = requireUid();
  const companyId = Number(payload.company_id);
  const fileName = clampStr(payload.file_name, 200);
  const storeGroup = normalizeStoreGroup(payload.store_group);
  const rawRows = Array.isArray(payload.rows) ? payload.rows : [];

  if (!companyId || !fileName) {
    throw new Error('company_id and file_name are required.');
  }
  if (rawRows.length === 0) {
    throw new Error('Uploaded file contains no valid data rows.');
  }

  const fileId = nextNumericId();
  const nowIso = new Date().toISOString();

  const normalizedRows: UploadedFileRow[] = rawRows.map((r, idx) => {
    const lookupKey = clampStr(r.lookup_key, 160);
    const caseNo = clampStr(r.case_no ?? '', 120);
    const partName = clampStr(r.part_name, 200) || 'Part Item';
    const partNumber = clampStr(r.part_number, 120) || lookupKey;
    const qty = Math.floor(Number(r.qty));
    const batchRef = clampStr(r.batch_ref, 120);

    if (!lookupKey || !partNumber || !Number.isInteger(qty) || qty <= 0) {
      throw new Error(
        `Invalid row ${idx + 1}: Column A (Batch NO.Case No.), Column D (Part No.), and positive integer Column E (Box Q'ty) are required.`
      );
    }

    return {
      id: nextNumericId(),
      file_id: fileId,
      company_id: companyId,
      lookup_key: lookupKey,
      case_no: caseNo,
      part_name: partName,
      part_number: partNumber,
      qty,
      batch_ref: batchRef,
    };
  });

  const fileHeader: Omit<UploadedFileRecord, 'rows'> = {
    id: fileId,
    company_id: companyId,
    file_name: fileName,
    row_count: normalizedRows.length,
    uploaded_by: actorLabel,
    uploaded_at: nowIso,
    store_group: storeGroup,
  };

  try {
    const CHUNK = 400;
    for (let start = 0; start < normalizedRows.length; start += CHUNK) {
      const batch = writeBatch(db);
      if (start === 0) {
        batch.set(doc(db, 'uploaded_files', String(fileId)), {
          ...fileHeader,
          createdByUid: uid,
          serverCreatedAt: serverTimestamp(),
        });
      }

      const slice = normalizedRows.slice(start, start + CHUNK);
      for (const row of slice) {
        batch.set(doc(db, 'uploaded_files', String(fileId), 'rows', String(row.id)), {
          ...row,
          createdByUid: uid,
        });
      }
      await batch.commit();
    }

    const verified = await getDocFromServer(doc(db, 'uploaded_files', String(fileId)));
    if (!verified.exists()) {
      throw new Error('File upload could not be confirmed on Cloud Firestore. Please retry.');
    }

    return {
      file: {
        ...fileHeader,
        rows: normalizedRows,
      },
    };
  } catch (err) {
    if (isPermissionError(err)) {
      handleFirestoreError(err, OperationType.WRITE, `uploaded_files/${fileId}`);
    }
    throw err;
  }
}

export async function deleteUploadedFile(fileId: number) {
  const path = `uploaded_files/${fileId}`;
  try {
    const fileRef = doc(db, 'uploaded_files', String(fileId));
    const snap = await getDoc(fileRef);
    if (!snap.exists()) {
      throw new Error('Uploaded file not found.');
    }
    const companyId = Number(snap.data().company_id);
    const rowsSnap = await getDocs(
      query(
        collection(db, 'uploaded_files', String(fileId), 'rows'),
        where('company_id', '==', companyId)
      )
    );

    const rowDocs = rowsSnap.docs;
    const CHUNK = 400;
    if (rowDocs.length === 0) {
      const batch = writeBatch(db);
      batch.delete(fileRef);
      await batch.commit();
    } else {
      for (let start = 0; start < rowDocs.length; start += CHUNK) {
        const batch = writeBatch(db);
        const slice = rowDocs.slice(start, start + CHUNK);
        for (const r of slice) {
          batch.delete(r.ref);
        }
        if (start + CHUNK >= rowDocs.length) {
          batch.delete(fileRef);
        }
        await batch.commit();
      }
    }

    return { deleted: true, id: fileId };
  } catch (err) {
    if (isPermissionError(err)) {
      handleFirestoreError(err, OperationType.DELETE, path);
    }
    throw err;
  }
}

export async function updateUploadedFileGroup(
  fileId: number,
  storeGroup: StoreFileGroup | ''
): Promise<{ id: number; store_group: StoreFileGroup | '' }> {
  requireUid();
  const normalizedGroup = normalizeStoreGroup(storeGroup);
  const path = `uploaded_files/${fileId}`;
  try {
    const fileRef = doc(db, 'uploaded_files', String(fileId));
    await updateDoc(fileRef, { store_group: normalizedGroup });
    return { id: fileId, store_group: normalizedGroup };
  } catch (err) {
    if (isPermissionError(err)) {
      handleFirestoreError(err, OperationType.UPDATE, path);
    }
    throw err;
  }
}

export async function lookupUploadedReceiving(
  companyId: number,
  rawScan: string,
  storeGroup?: StoreFileGroup | ''
): Promise<MasterLookupResponse> {
  let cleaned = rawScan.replace(/[\r\n]+/g, '').trim();
  const aimMatch = cleaned.match(/^\]([A-Za-z][0-9A-Za-z])/);
  if (aimMatch) {
    cleaned = cleaned.slice(aimMatch[0].length).trim();
  }

  if (!cleaned) {
    return { matched: false, matchedKey: null, fileName: null, storeGroup: '', items: [] };
  }

  const targetGroup = normalizeStoreGroup(storeGroup);
  const { files } = await getAllUploadedFiles();
  const groupScopedFiles = targetGroup
    ? files.filter((f) => normalizeStoreGroup(f.store_group) === targetGroup)
    : files;

  // Prefer active company's files first (newest first), then fall back to other uploaded files
  const prioritizedFiles = [...groupScopedFiles].sort((a, b) => {
    const aMatch = a.company_id === Number(companyId) ? 0 : 1;
    const bMatch = b.company_id === Number(companyId) ? 0 : 1;
    if (aMatch !== bMatch) return aMatch - bMatch;
    return b.id - a.id;
  });

  const flatRows: Array<UploadedFileRow & { file_name: string; store_group: StoreFileGroup | '' }> = [];
  for (const file of prioritizedFiles) {
    const fileGroup = normalizeStoreGroup(file.store_group);
    for (const row of file.rows) {
      flatRows.push({ ...row, file_name: file.file_name, store_group: fileGroup });
    }
  }

  if (flatRows.length === 0) {
    return { matched: false, matchedKey: null, fileName: null, storeGroup: '', items: [] };
  }

  const cleanedUpper = cleaned.toUpperCase();
  const segmentsUpper = cleaned
    .split(/[\/_\\\s]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  const getRowBoxNo = (r: UploadedFileRow): string =>
    (r.case_no !== undefined ? r.case_no : r.part_name || '').trim();

  // Match priority:
  // 1) exact match on Col A (Batch NO.Case No.)
  // 2) exact match on Col B (Case No. / Box Number)
  // 3) segment match on Col A or Col B
  // 4) substring match on Col A or Col B
  let matchedBy: 'lookup_key' | 'case_no' = 'lookup_key';
  let matchedRow = flatRows.find((r) => r.lookup_key.trim().toUpperCase() === cleanedUpper);

  if (!matchedRow) {
    matchedRow = flatRows.find((r) => getRowBoxNo(r).toUpperCase() === cleanedUpper);
    if (matchedRow) matchedBy = 'case_no';
  }

  if (!matchedRow) {
    for (const seg of segmentsUpper) {
      matchedRow = flatRows.find((r) => r.lookup_key.trim().toUpperCase() === seg);
      if (matchedRow) {
        matchedBy = 'lookup_key';
        break;
      }
      matchedRow = flatRows.find((r) => getRowBoxNo(r).toUpperCase() === seg);
      if (matchedRow) {
        matchedBy = 'case_no';
        break;
      }
    }
  }

  if (!matchedRow) {
    const substringMatches = flatRows
      .filter((r) => {
        const keyA = r.lookup_key.trim().toUpperCase();
        const keyB = getRowBoxNo(r).toUpperCase();
        return (keyA.length > 0 && cleanedUpper.includes(keyA)) || (keyB.length > 0 && cleanedUpper.includes(keyB));
      })
      .sort((a, b) => {
        const maxLenB = Math.max((b.lookup_key || '').length, getRowBoxNo(b).length);
        const maxLenA = Math.max((a.lookup_key || '').length, getRowBoxNo(a).length);
        return maxLenB - maxLenA || b.file_id - a.file_id;
      });
    matchedRow = substringMatches[0];
    if (matchedRow) {
      const keyA = matchedRow.lookup_key.trim().toUpperCase();
      matchedBy = keyA.length > 0 && cleanedUpper.includes(keyA) ? 'lookup_key' : 'case_no';
    }
  }

  if (!matchedRow) {
    return { matched: false, matchedKey: null, fileName: null, storeGroup: '', items: [] };
  }

  const targetKeyUpper = matchedRow.lookup_key.trim().toUpperCase();
  const targetBoxUpper = getRowBoxNo(matchedRow).toUpperCase();
  const targetFileId = matchedRow.file_id;
  const matchedItems: UploadedFileRow[] = flatRows
    .filter((r) => {
      if (r.file_id !== targetFileId) return false;
      if (matchedBy === 'case_no' && targetBoxUpper) {
        return getRowBoxNo(r).toUpperCase() === targetBoxUpper;
      }
      if (targetKeyUpper && r.lookup_key.trim().toUpperCase() === targetKeyUpper) return true;
      if (!targetKeyUpper && targetBoxUpper && getRowBoxNo(r).toUpperCase() === targetBoxUpper) return true;
      return false;
    })
    .map(({ file_name: _fn, store_group: _sg, ...row }) => row);

  return {
    matched: true,
    matchedKey:
      matchedBy === 'case_no'
        ? targetKeyUpper ? matchedRow.lookup_key.trim() : getRowBoxNo(matchedRow)
        : matchedRow.lookup_key.trim() || getRowBoxNo(matchedRow),
    fileName: matchedRow.file_name,
    storeGroup: matchedRow.store_group,
    items: matchedItems,
  };
}

export async function getUsers(): Promise<{ users: UserRecord[] }> {
  const { uid } = requireUid();
  const path = 'users';
  try {
    const isBoot =
      Boolean(auth.currentUser?.emailVerified) &&
      (auth.currentUser?.email || '').toLowerCase() === BOOTSTRAP_ADMIN_EMAIL;

    const mapDoc = (d: { id: string; data: () => Record<string, unknown> }): UserRecord => {
      const data = d.data() as {
        uid: string;
        username: string;
        full_name: string;
        role: UserRole;
        active: number;
        created_at: string;
      };
      return {
        id: data.uid || d.id,
        uid: data.uid || d.id,
        username: data.username,
        full_name: data.full_name,
        role: data.role,
        active: data.active,
        created_at: data.created_at,
      };
    };

    const byUid = new Map<string, UserRecord>();
    if (isBoot) {
      const snap = await getDocs(collection(db, 'users'));
      for (const d of snap.docs) {
        const rec = mapDoc(d);
        byUid.set(rec.id, rec);
      }
    } else {
      const [createdSnap, selfSnap] = await Promise.all([
        getDocs(query(collection(db, 'users'), where('createdByUid', '==', uid))),
        getDoc(doc(db, 'users', uid)),
      ]);
      for (const d of createdSnap.docs) {
        const rec = mapDoc(d);
        byUid.set(rec.id, rec);
      }
      if (selfSnap.exists()) {
        const rec = mapDoc(selfSnap);
        byUid.set(rec.id, rec);
      }
    }

    const users = Array.from(byUid.values()).sort((a, b) =>
      a.created_at.localeCompare(b.created_at)
    );
    return { users };
  } catch (err) {
    if (isPermissionError(err)) {
      handleFirestoreError(err, OperationType.LIST, path);
    }
    throw err;
  }
}

export async function createUser(payload: {
  username: string;
  full_name: string;
  password: string;
  role: UserRole;
}): Promise<UserRecord> {
  const { uid: adminUid } = requireUid();
  const cleanUsername = clampStr(formatUsernameLabel(payload.username), 120);
  const cleanFullName = clampStr(payload.full_name, 120);
  const password = payload.password || '';
  const role: UserRole = ['admin', 'supervisor', 'operator'].includes(payload.role)
    ? payload.role
    : 'operator';

  if (cleanUsername.length < 2 || !cleanFullName || password.length < 6) {
    throw new Error('Username (min 2 chars), full name, and password (min 6 chars) are required.');
  }

  const authEmail = toAuthEmail(cleanUsername);
  const secondaryAuth = getSecondaryAuth();
  let cred;
  try {
    cred = await createUserWithEmailAndPassword(secondaryAuth, authEmail, password);
  } catch (err) {
    throw new Error(mapFirebaseAuthError(err, 'create_user'));
  }

  const newUid = cred.user.uid;
  const nowIso = new Date().toISOString();

  try {
    const batch = writeBatch(db);
    batch.set(doc(db, 'users', newUid), {
      uid: newUid,
      username: cleanUsername,
      full_name: cleanFullName,
      role,
      active: 1,
      created_at: nowIso,
      createdByUid: adminUid,
      serverCreatedAt: serverTimestamp(),
    });
    if (role === 'admin') {
      batch.set(doc(db, 'admins', newUid), {
        uid: newUid,
        email: clampStr(authEmail, 160),
        grantedAt: serverTimestamp(),
      });
    }
    await batch.commit();

    return {
      id: newUid,
      uid: newUid,
      username: cleanUsername,
      full_name: cleanFullName,
      role,
      active: 1,
      created_at: nowIso,
    };
  } catch (err) {
    try {
      await deleteUser(cred.user);
    } catch {
      // Ignore cleanup failure
    }
    if (isPermissionError(err)) {
      handleFirestoreError(err, OperationType.CREATE, `users/${newUid}`);
    }
    throw err;
  } finally {
    try {
      await signOut(secondaryAuth);
    } catch {
      // Ignore sign-out errors on secondary app
    }
  }
}

export async function updateUser(
  userId: string | number,
  patch: { role?: UserRole; active?: number }
): Promise<{ id: string; role: UserRole; active: number }> {
  const uid = String(userId);
  const path = `users/${uid}`;
  try {
    const userRef = doc(db, 'users', uid);
    const snap = await getDoc(userRef);
    if (!snap.exists()) {
      throw new Error('User profile not found.');
    }
    const existing = snap.data() as {
      uid: string;
      username: string;
      full_name: string;
      role: UserRole;
      active: number;
    };

    const nextRole = patch.role ?? existing.role;
    const nextActive = typeof patch.active === 'number' ? patch.active : existing.active;

    if (auth.currentUser?.uid === uid && nextActive === 0) {
      throw new Error('Cannot deactivate your own active admin account.');
    }

    const batch = writeBatch(db);
    batch.update(userRef, {
      role: nextRole,
      active: nextActive,
    });

    const adminRef = doc(db, 'admins', uid);
    if (nextRole === 'admin') {
      batch.set(adminRef, {
        uid,
        email: clampStr(existing.username, 160),
        grantedAt: serverTimestamp(),
      });
    } else if (auth.currentUser?.uid !== uid) {
      batch.delete(adminRef);
    }

    await batch.commit();
    return { id: uid, role: nextRole, active: nextActive };
  } catch (err) {
    if (isPermissionError(err)) {
      handleFirestoreError(err, OperationType.UPDATE, path);
    }
    throw err;
  }
}
