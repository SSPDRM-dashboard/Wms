import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { db, initDatabase } from './server/db.ts';
import { parseQrScan } from './server/qrParser.ts';
import {
  requireAuth,
  requireRole,
  signToken,
  type AuthenticatedRequest,
  type UserRole,
} from './server/auth.ts';

initDatabase();

const app = express();
const PORT = process.env.NODE_ENV === 'production' ? Number(process.env.PORT) || 3000 : 3000;
const rawCors = process.env.CORS_ORIGINS;
const CORS_ORIGINS =
  rawCors && (rawCors === '*' || rawCors.startsWith('http')) ? rawCors : '*';

app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', CORS_ORIGINS);
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

function withTransaction<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE;');
  try {
    const result = fn();
    db.exec('COMMIT;');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // Ignore rollback errors if not in transaction
    }
    throw err;
  }
}

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'cloud-wms', timestamp: new Date().toISOString() });
});

// Login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    res.status(400).json({ error: 'Username and password are required.' });
    return;
  }

  const user = db
    .prepare('SELECT id, username, full_name, password_hash, role, active FROM users WHERE username = ?')
    .get(String(username).trim()) as
    | { id: number; username: string; full_name: string; password_hash: string; role: UserRole; active: number }
    | undefined;

  if (!user || !bcrypt.compareSync(String(password), user.password_hash)) {
    res.status(401).json({ error: 'Invalid username or password.' });
    return;
  }

  if (!user.active) {
    res.status(403).json({ error: 'User account is deactivated. Contact an administrator.' });
    return;
  }

  const token = signToken({
    userId: user.id,
    username: user.username,
    fullName: user.full_name,
    role: user.role,
  });

  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      fullName: user.full_name,
      role: user.role,
    },
  });
});

// Current authenticated user
app.get('/api/me', requireAuth, (req: AuthenticatedRequest, res) => {
  res.json({ user: req.user });
});

// Companies
app.get('/api/companies', requireAuth, (_req, res) => {
  const companies = db
    .prepare('SELECT id, code, name, qr_profile, description FROM companies ORDER BY id ASC')
    .all();
  res.json({ companies });
});

// QR Scan Parser
app.post('/api/scan/parse', requireAuth, (req, res) => {
  const companyId = Number(req.body?.company_id);
  const rawScan = String(req.body?.raw_scan ?? '');

  if (!companyId || !Number.isInteger(companyId)) {
    res.status(400).json({ error: 'Valid company_id is required.' });
    return;
  }

  const company = db.prepare('SELECT id FROM companies WHERE id = ?').get(companyId);
  if (!company) {
    res.status(404).json({ error: 'Company not found.' });
    return;
  }

  const parsed = parseQrScan(companyId, rawScan);
  res.json(parsed);
});

// Complete Container (atomic commit of pending scans)
app.post('/api/containers/complete', requireAuth, (req: AuthenticatedRequest, res) => {
  const companyId = Number(req.body?.company_id);
  const containerCode = String(req.body?.container_code ?? '').trim();
  const palletRef = String(req.body?.pallet_ref ?? '').trim();
  const location = String(req.body?.location ?? '').trim() || 'RCV-DOCK-01';
  const items = Array.isArray(req.body?.items) ? req.body.items : [];

  if (!companyId || !containerCode) {
    res.status(400).json({ error: 'company_id and container_code are required.' });
    return;
  }
  if (items.length === 0) {
    res.status(400).json({ error: 'At least one staged box scan is required to complete a container.' });
    return;
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item?.partNumber || !item?.boxId || !Number.isInteger(Number(item.qty)) || Number(item.qty) <= 0) {
      res.status(400).json({ error: `Invalid item at row ${i + 1}: partNumber, boxId, and positive integer qty are required.` });
      return;
    }
  }

  const actor = req.user!.username;
  const nowIso = new Date().toISOString();

  try {
    const result = withTransaction(() => {
      let totalUnits = 0;
      const distinctLocations = new Set<string>();
      for (const item of items) {
        totalUnits += Number(item.qty);
        const loc = String(item.location ?? '').trim() || location;
        distinctLocations.add(loc);
      }

      const containerLocationSummary =
        distinctLocations.size === 1
          ? Array.from(distinctLocations)[0]
          : `${location} (${distinctLocations.size} bins)`;

      const containerRes = db
        .prepare(
          'INSERT INTO containers (company_id, container_code, pallet_ref, location, total_boxes, total_units, received_by, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          companyId,
          containerCode,
          palletRef,
          containerLocationSummary,
          items.length,
          totalUnits,
          actor,
          nowIso
        );
      const containerId = Number(containerRes.lastInsertRowid);

      const insertLot = db.prepare(
        'INSERT INTO inventory_lots (company_id, part_number, qty, initial_qty, box_id, batch_ref, location, container_id, pallet_ref, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );
      const insertMove = db.prepare(
        'INSERT INTO movements (company_id, movement_type, part_number, qty_delta, box_id, batch_ref, from_location, to_location, reference_code, lot_id, performed_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );

      const createdLotIds: number[] = [];
      for (const item of items) {
        const qty = Number(item.qty);
        const partNumber = String(item.partNumber).trim();
        const boxId = String(item.boxId).trim();
        const batchRef = String(item.batchRef ?? '').trim();
        const itemPalletRef = String(item.palletRef ?? palletRef).trim();
        const itemLocation = String(item.location ?? '').trim() || location;

        const lotRes = insertLot.run(
          companyId,
          partNumber,
          qty,
          qty,
          boxId,
          batchRef,
          itemLocation,
          containerId,
          itemPalletRef,
          nowIso
        );
        const lotId = Number(lotRes.lastInsertRowid);
        createdLotIds.push(lotId);

        insertMove.run(
          companyId,
          'RECEIVE',
          partNumber,
          qty,
          boxId,
          batchRef,
          'INBOUND',
          itemLocation,
          containerCode,
          lotId,
          actor,
          nowIso
        );
      }

      return {
        containerId,
        containerCode,
        totalBoxes: items.length,
        totalUnits,
        location: containerLocationSummary,
        palletRef,
        createdLotIds,
        completedAt: nowIso,
      };
    });

    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to commit container.' });
  }
});

// Recent Containers
app.get('/api/containers', requireAuth, (req, res) => {
  const companyId = Number(req.query.company_id);
  if (!companyId) {
    res.status(400).json({ error: 'company_id is required.' });
    return;
  }
  const containers = db
    .prepare(
      'SELECT id, company_id, container_code, pallet_ref, location, total_boxes, total_units, received_by, completed_at FROM containers WHERE company_id = ? ORDER BY completed_at DESC, id DESC LIMIT 25'
    )
    .all(companyId);
  res.json({ containers });
});

// Inventory Search & Summary
app.get('/api/inventory', requireAuth, (req, res) => {
  const companyId = Number(req.query.company_id);
  if (!companyId) {
    res.status(400).json({ error: 'company_id is required.' });
    return;
  }

  const search = String(req.query.search ?? '').trim();
  const location = String(req.query.location ?? '').trim();
  const includeZero = req.query.include_zero === 'true';

  const clauses: string[] = ['l.company_id = ?'];
  const params: (string | number)[] = [companyId];

  if (!includeZero) {
    clauses.push('l.qty > 0');
  }
  if (location) {
    clauses.push('l.location = ?');
    params.push(location);
  }
  if (search) {
    clauses.push('(l.part_number LIKE ? OR l.box_id LIKE ? OR l.batch_ref LIKE ? OR l.location LIKE ? OR l.pallet_ref LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like, like);
  }

  const whereSql = clauses.join(' AND ');

  const lots = db
    .prepare(
      `SELECT l.id, l.company_id, l.part_number, l.qty, l.initial_qty, l.box_id, l.batch_ref,
              l.location, l.container_id, l.pallet_ref, l.received_at, c.container_code
       FROM inventory_lots l
       LEFT JOIN containers c ON c.id = l.container_id
       WHERE ${whereSql}
       ORDER BY l.received_at ASC, l.id ASC`
    )
    .all(...params);

  const skuSummary = db
    .prepare(
      `SELECT l.part_number, SUM(l.qty) AS total_qty, COUNT(*) AS box_count,
              COUNT(DISTINCT l.location) AS location_count,
              MIN(l.received_at) AS oldest_received_at
       FROM inventory_lots l
       WHERE ${whereSql}
       GROUP BY l.part_number
       ORDER BY l.part_number ASC`
    )
    .all(...params);

  const locations = db
    .prepare(
      'SELECT DISTINCT location FROM inventory_lots WHERE company_id = ? AND qty > 0 ORDER BY location ASC'
    )
    .all(companyId)
    .map((r) => (r as { location: string }).location);

  res.json({ lots, skuSummary, locations });
});

// Clear Stock disabled — inventory data is immutable outside audited movements
app.post('/api/inventory/clear', requireAuth, requireRole(['admin']), (_req, res) => {
  res.status(403).json({
    error:
      'Inventory data is locked and cannot be cleared or directly modified. Stock changes are only allowed through audited Receiving, Transfer, or Outbound transactions.',
  });
});

// FIFO Allocation Helper
function computeFifoPlan(companyId: number, partNumber: string, requestedQty: number, location?: string) {
  const clauses = ['company_id = ?', 'part_number = ?', 'qty > 0'];
  const params: (string | number)[] = [companyId, partNumber];
  if (location) {
    clauses.push('location = ?');
    params.push(location);
  }

  const lots = db
    .prepare(
      `SELECT id, part_number, qty, box_id, batch_ref, location, received_at
       FROM inventory_lots
       WHERE ${clauses.join(' AND ')}
       ORDER BY received_at ASC, id ASC`
    )
    .all(...params) as Array<{
    id: number;
    part_number: string;
    qty: number;
    box_id: string;
    batch_ref: string;
    location: string;
    received_at: string;
  }>;

  const totalAvailable = lots.reduce((sum, l) => sum + l.qty, 0);
  const allocations: Array<{
    lotId: number;
    boxId: string;
    batchRef: string;
    location: string;
    receivedAt: string;
    availableBefore: number;
    takeQty: number;
    remainingAfter: number;
  }> = [];

  let remainingNeeded = requestedQty;
  for (const lot of lots) {
    if (remainingNeeded <= 0) break;
    const takeQty = Math.min(lot.qty, remainingNeeded);
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
    remainingNeeded -= takeQty;
  }

  return {
    partNumber,
    requestedQty,
    totalAvailable,
    sufficient: totalAvailable >= requestedQty,
    shortfall: Math.max(0, requestedQty - totalAvailable),
    allocations,
  };
}

// FIFO Preview
app.get('/api/outbound/preview', requireAuth, (req, res) => {
  const companyId = Number(req.query.company_id);
  const partNumber = String(req.query.part_number ?? '').trim();
  const qty = Number(req.query.qty);
  const location = String(req.query.location ?? '').trim() || undefined;

  if (!companyId || !partNumber || !Number.isInteger(qty) || qty <= 0) {
    res.status(400).json({ error: 'company_id, part_number, and positive integer qty are required.' });
    return;
  }

  const plan = computeFifoPlan(companyId, partNumber, qty, location);
  res.json(plan);
});

// FIFO Outbound Issuing
app.post('/api/outbound', requireAuth, (req: AuthenticatedRequest, res) => {
  const companyId = Number(req.body?.company_id);
  const partNumber = String(req.body?.part_number ?? '').trim();
  const qty = Number(req.body?.qty);
  const referenceCode = String(req.body?.reference_code ?? '').trim() || 'OUTBOUND';
  const destination = String(req.body?.destination ?? '').trim() || 'DISPATCH';
  const location = String(req.body?.location ?? '').trim() || undefined;

  if (!companyId || !partNumber || !Number.isInteger(qty) || qty <= 0) {
    res.status(400).json({ error: 'company_id, part_number, and positive integer qty are required.' });
    return;
  }

  const actor = req.user!.username;
  const nowIso = new Date().toISOString();

  try {
    const result = withTransaction(() => {
      const plan = computeFifoPlan(companyId, partNumber, qty, location);
      if (!plan.sufficient) {
        return { error: `Insufficient stock for ${partNumber}. Available: ${plan.totalAvailable}, requested: ${qty}.`, status: 409 as const };
      }

      const updateLot = db.prepare('UPDATE inventory_lots SET qty = ? WHERE id = ?');
      const insertMove = db.prepare(
        'INSERT INTO movements (company_id, movement_type, part_number, qty_delta, box_id, batch_ref, from_location, to_location, reference_code, lot_id, performed_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );

      for (const alloc of plan.allocations) {
        updateLot.run(alloc.remainingAfter, alloc.lotId);
        insertMove.run(
          companyId,
          'OUTBOUND_FIFO',
          partNumber,
          -alloc.takeQty,
          alloc.boxId,
          alloc.batchRef,
          alloc.location,
          destination,
          referenceCode,
          alloc.lotId,
          actor,
          nowIso
        );
      }

      return {
        status: 200 as const,
        data: {
          partNumber,
          issuedQty: qty,
          referenceCode,
          destination,
          allocations: plan.allocations,
          issuedAt: nowIso,
        },
      };
    });

    if ('error' in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    res.json(result.data);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Outbound FIFO failed.' });
  }
});

// Outbound QR Scan Lookup (mirrors inbound QR parsing + matches active inventory lot)
app.post('/api/outbound/scan', requireAuth, (req, res) => {
  const companyId = Number(req.body?.company_id);
  const rawScan = String(req.body?.raw_scan ?? '');

  if (!companyId || !Number.isInteger(companyId)) {
    res.status(400).json({ error: 'Valid company_id is required.' });
    return;
  }

  const company = db.prepare('SELECT id FROM companies WHERE id = ?').get(companyId);
  if (!company) {
    res.status(404).json({ error: 'Company not found.' });
    return;
  }

  const parsed = parseQrScan(companyId, rawScan);
  if (!parsed.valid || parsed.kind !== 'box_inventory' || !parsed.boxId) {
    res.json({ parsed, matchedLot: null, olderFifoLot: null });
    return;
  }

  const matchedLot = db
    .prepare(
      `SELECT id, company_id, part_number, qty, initial_qty, box_id, batch_ref,
              location, container_id, pallet_ref, received_at
       FROM inventory_lots
       WHERE company_id = ? AND LOWER(box_id) = LOWER(?) AND qty > 0
       ORDER BY received_at ASC, id ASC
       LIMIT 1`
    )
    .get(companyId, parsed.boxId) as
    | {
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
      }
    | undefined;

  if (!matchedLot) {
    res.json({
      parsed: {
        ...parsed,
        valid: false,
        kind: 'invalid',
        addsInventory: false,
        message: `Box "${parsed.boxId}" has no active stock for this company.`,
      },
      matchedLot: null,
      olderFifoLot: null,
    });
    return;
  }

  const olderFifoLot = db
    .prepare(
      `SELECT id, box_id, location, qty, received_at
       FROM inventory_lots
       WHERE company_id = ? AND part_number = ? AND qty > 0
         AND (received_at < ? OR (received_at = ? AND id < ?))
       ORDER BY received_at ASC, id ASC
       LIMIT 1`
    )
    .get(
      companyId,
      matchedLot.part_number,
      matchedLot.received_at,
      matchedLot.received_at,
      matchedLot.id
    ) as
    | { id: number; box_id: string; location: string; qty: number; received_at: string }
    | undefined;

  res.json({
    parsed,
    matchedLot,
    olderFifoLot: olderFifoLot ?? null,
  });
});

// Complete Staged Outbound Shipment (atomic commit of scanned boxes)
app.post('/api/outbound/complete', requireAuth, (req: AuthenticatedRequest, res) => {
  const companyId = Number(req.body?.company_id);
  const referenceCode = String(req.body?.reference_code ?? '').trim() || 'OUTBOUND';
  const destination = String(req.body?.destination ?? '').trim() || 'DISPATCH';
  const palletRef = String(req.body?.pallet_ref ?? '').trim();
  const items = Array.isArray(req.body?.items) ? req.body.items : [];

  if (!companyId) {
    res.status(400).json({ error: 'Valid company_id is required.' });
    return;
  }
  if (items.length === 0) {
    res.status(400).json({ error: 'At least one scanned box is required to submit outbound.' });
    return;
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item?.lotId || !Number.isInteger(Number(item.qty)) || Number(item.qty) <= 0) {
      res.status(400).json({ error: `Invalid outbound item at row ${i + 1}: lotId and positive integer qty are required.` });
      return;
    }
  }

  const actor = req.user!.username;
  const nowIso = new Date().toISOString();

  try {
    const result = withTransaction(() => {
      const getLot = db.prepare(
        'SELECT id, part_number, qty, box_id, batch_ref, location FROM inventory_lots WHERE id = ? AND company_id = ?'
      );
      const updateLot = db.prepare('UPDATE inventory_lots SET qty = ? WHERE id = ?');
      const insertMove = db.prepare(
        'INSERT INTO movements (company_id, movement_type, part_number, qty_delta, box_id, batch_ref, from_location, to_location, reference_code, lot_id, performed_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );

      let totalUnits = 0;
      for (const item of items) {
        const takeQty = Number(item.qty);
        const lot = getLot.get(Number(item.lotId), companyId) as
          | { id: number; part_number: string; qty: number; box_id: string; batch_ref: string; location: string }
          | undefined;

        if (!lot) {
          return { error: `Inventory lot #${item.lotId} was not found for this company.`, status: 404 as const };
        }
        if (lot.qty < takeQty) {
          return {
            error: `Insufficient quantity on box ${lot.box_id}: available ${lot.qty}, requested ${takeQty}.`,
            status: 409 as const,
          };
        }

        updateLot.run(lot.qty - takeQty, lot.id);
        insertMove.run(
          companyId,
          'OUTBOUND_FIFO',
          lot.part_number,
          -takeQty,
          lot.box_id,
          lot.batch_ref,
          lot.location,
          destination,
          palletRef ? `${referenceCode} (${palletRef})` : referenceCode,
          lot.id,
          actor,
          nowIso
        );
        totalUnits += takeQty;
      }

      return {
        status: 200 as const,
        data: {
          referenceCode,
          destination,
          palletRef,
          totalBoxes: items.length,
          totalUnits,
          issuedAt: nowIso,
        },
      };
    });

    if ('error' in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    res.json(result.data);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to commit outbound shipment.' });
  }
});

// Stock Transfer
app.post('/api/transfer', requireAuth, (req: AuthenticatedRequest, res) => {
  const companyId = Number(req.body?.company_id);
  const lotId = Number(req.body?.lot_id);
  const qty = Number(req.body?.qty);
  const toLocation = String(req.body?.to_location ?? '').trim();
  const referenceCode = String(req.body?.reference_code ?? '').trim() || 'TRANSFER';

  if (!companyId || !lotId || !Number.isInteger(qty) || qty <= 0 || !toLocation) {
    res.status(400).json({ error: 'company_id, lot_id, positive integer qty, and to_location are required.' });
    return;
  }

  const actor = req.user!.username;
  const nowIso = new Date().toISOString();

  try {
    const result = withTransaction(() => {
      const lot = db
        .prepare(
          'SELECT id, company_id, part_number, qty, initial_qty, box_id, batch_ref, location, container_id, pallet_ref, received_at FROM inventory_lots WHERE id = ? AND company_id = ?'
        )
        .get(lotId, companyId) as
        | {
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
          }
        | undefined;

      if (!lot) {
        return { error: 'Inventory lot not found for this company.', status: 404 as const };
      }
      if (lot.qty < qty) {
        return { error: `Transfer qty (${qty}) exceeds available lot qty (${lot.qty}).`, status: 409 as const };
      }
      if (lot.location === toLocation) {
        return { error: `Lot is already in location "${toLocation}".`, status: 400 as const };
      }

      const fromLocation = lot.location;
      let targetLotId = lot.id;

      if (qty === lot.qty) {
        db.prepare('UPDATE inventory_lots SET location = ? WHERE id = ?').run(toLocation, lot.id);
      } else {
        db.prepare('UPDATE inventory_lots SET qty = qty - ? WHERE id = ?').run(qty, lot.id);
        const splitRes = db
          .prepare(
            'INSERT INTO inventory_lots (company_id, part_number, qty, initial_qty, box_id, batch_ref, location, container_id, pallet_ref, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          )
          .run(
            lot.company_id,
            lot.part_number,
            qty,
            qty,
            lot.box_id,
            lot.batch_ref,
            toLocation,
            lot.container_id,
            lot.pallet_ref,
            lot.received_at
          );
        targetLotId = Number(splitRes.lastInsertRowid);
      }

      db.prepare(
        'INSERT INTO movements (company_id, movement_type, part_number, qty_delta, box_id, batch_ref, from_location, to_location, reference_code, lot_id, performed_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        companyId,
        'TRANSFER',
        lot.part_number,
        qty,
        lot.box_id,
        lot.batch_ref,
        fromLocation,
        toLocation,
        referenceCode,
        targetLotId,
        actor,
        nowIso
      );

      return {
        status: 200 as const,
        data: {
          lotId: targetLotId,
          partNumber: lot.part_number,
          boxId: lot.box_id,
          qtyTransferred: qty,
          fromLocation,
          toLocation,
          transferredAt: nowIso,
        },
      };
    });

    if ('error' in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    res.json(result.data);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Stock transfer failed.' });
  }
});

// Movement History
app.get('/api/movements', requireAuth, (req, res) => {
  const companyId = Number(req.query.company_id);
  if (!companyId) {
    res.status(400).json({ error: 'company_id is required.' });
    return;
  }

  const type = String(req.query.type ?? '').trim();
  const search = String(req.query.search ?? '').trim();
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));

  const clauses = ['company_id = ?'];
  const params: (string | number)[] = [companyId];

  if (type && ['RECEIVE', 'OUTBOUND_FIFO', 'TRANSFER'].includes(type)) {
    clauses.push('movement_type = ?');
    params.push(type);
  }

  if (search) {
    clauses.push('(part_number LIKE ? OR box_id LIKE ? OR batch_ref LIKE ? OR reference_code LIKE ? OR from_location LIKE ? OR to_location LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like, like, like);
  }

  const movements = db
    .prepare(
      `SELECT id, company_id, movement_type, part_number, qty_delta, box_id, batch_ref,
              from_location, to_location, reference_code, lot_id, performed_by, created_at
       FROM movements
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`
    )
    .all(...params, limit);

  res.json({ movements });
});

// Inventory & Operations Summary Report
app.get('/api/reports/summary', requireAuth, (req, res) => {
  const companyId = Number(req.query.company_id);
  if (!companyId) {
    res.status(400).json({ error: 'company_id is required.' });
    return;
  }

  const stockTotals = db
    .prepare(
      `SELECT COALESCE(SUM(qty), 0) AS total_units,
              COUNT(*) AS active_boxes,
              COUNT(DISTINCT part_number) AS distinct_skus,
              COUNT(DISTINCT location) AS active_locations
       FROM inventory_lots
       WHERE company_id = ? AND qty > 0`
    )
    .get(companyId) as {
    total_units: number;
    active_boxes: number;
    distinct_skus: number;
    active_locations: number;
  };

  const containerStats = db
    .prepare(
      'SELECT COUNT(*) AS total_containers, COALESCE(SUM(total_boxes), 0) AS received_boxes FROM containers WHERE company_id = ?'
    )
    .get(companyId) as { total_containers: number; received_boxes: number };

  const movementBreakdown = db
    .prepare(
      `SELECT movement_type, COUNT(*) AS tx_count, COALESCE(SUM(ABS(qty_delta)), 0) AS total_units
       FROM movements
       WHERE company_id = ?
       GROUP BY movement_type`
    )
    .all(companyId);

  const byLocation = db
    .prepare(
      `SELECT location, SUM(qty) AS total_qty, COUNT(*) AS box_count, COUNT(DISTINCT part_number) AS sku_count
       FROM inventory_lots
       WHERE company_id = ? AND qty > 0
       GROUP BY location
       ORDER BY total_qty DESC`
    )
    .all(companyId);

  const topParts = db
    .prepare(
      `SELECT part_number, SUM(qty) AS total_qty, COUNT(*) AS box_count, MIN(received_at) AS oldest_lot
       FROM inventory_lots
       WHERE company_id = ? AND qty > 0
       GROUP BY part_number
       ORDER BY total_qty DESC
       LIMIT 10`
    )
    .all(companyId);

  res.json({
    stockTotals,
    containerStats,
    movementBreakdown,
    byLocation,
    topParts,
  });
});

// BOM Storage & Retrieval
app.get('/api/bom', requireAuth, (req, res) => {
  const companyId = Number(req.query.company_id);
  if (!companyId) {
    res.status(400).json({ error: 'company_id is required.' });
    return;
  }

  const boms = db
    .prepare(
      'SELECT id, company_id, parent_part, description, revision, created_by, updated_at FROM boms WHERE company_id = ? ORDER BY parent_part ASC'
    )
    .all(companyId) as Array<{
    id: number;
    company_id: number;
    parent_part: string;
    description: string;
    revision: string;
    created_by: string;
    updated_at: string;
  }>;

  const stockRows = db
    .prepare(
      'SELECT part_number, SUM(qty) AS available_qty FROM inventory_lots WHERE company_id = ? AND qty > 0 GROUP BY part_number'
    )
    .all(companyId) as Array<{ part_number: string; available_qty: number }>;

  const stockMap = new Map<string, number>();
  for (const row of stockRows) {
    stockMap.set(row.part_number, row.available_qty);
  }

  const itemStmt = db.prepare(
    'SELECT id, bom_id, component_part, qty_per_assembly, notes FROM bom_items WHERE bom_id = ? ORDER BY id ASC'
  );

  const enriched = boms.map((bom) => {
    const items = itemStmt.all(bom.id) as Array<{
      id: number;
      bom_id: number;
      component_part: string;
      qty_per_assembly: number;
      notes: string;
    }>;

    let maxBuildable = items.length > 0 ? Infinity : 0;
    const componentsWithStock = items.map((item) => {
      const availableQty = stockMap.get(item.component_part) ?? 0;
      const buildableFromComponent = Math.floor(availableQty / item.qty_per_assembly);
      if (buildableFromComponent < maxBuildable) {
        maxBuildable = buildableFromComponent;
      }
      return {
        ...item,
        available_qty: availableQty,
        buildable_assemblies: buildableFromComponent,
      };
    });

    return {
      ...bom,
      max_buildable: maxBuildable === Infinity ? 0 : maxBuildable,
      items: componentsWithStock,
    };
  });

  res.json({ boms: enriched });
});

app.post('/api/bom', requireAuth, requireRole(['admin', 'supervisor']), (req: AuthenticatedRequest, res) => {
  const companyId = Number(req.body?.company_id);
  const parentPart = String(req.body?.parent_part ?? '').trim();
  const description = String(req.body?.description ?? '').trim();
  const revision = String(req.body?.revision ?? 'A').trim() || 'A';
  const items = Array.isArray(req.body?.items) ? req.body.items : [];

  if (!companyId || !parentPart || items.length === 0) {
    res.status(400).json({ error: 'company_id, parent_part, and at least one component line are required.' });
    return;
  }

  for (const item of items) {
    if (!item?.component_part || !Number.isInteger(Number(item.qty_per_assembly)) || Number(item.qty_per_assembly) <= 0) {
      res.status(400).json({ error: 'Each BOM component requires component_part and positive integer qty_per_assembly.' });
      return;
    }
  }

  const actor = req.user!.username;
  const nowIso = new Date().toISOString();

  try {
    const bomId = withTransaction(() => {
      const existing = db
        .prepare('SELECT id FROM boms WHERE company_id = ? AND parent_part = ?')
        .get(companyId, parentPart) as { id: number } | undefined;

      let targetBomId: number;
      if (existing) {
        targetBomId = existing.id;
        db.prepare(
          'UPDATE boms SET description = ?, revision = ?, created_by = ?, updated_at = ? WHERE id = ?'
        ).run(description, revision, actor, nowIso, targetBomId);
        db.prepare('DELETE FROM bom_items WHERE bom_id = ?').run(targetBomId);
      } else {
        const resInsert = db
          .prepare(
            'INSERT INTO boms (company_id, parent_part, description, revision, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
          )
          .run(companyId, parentPart, description, revision, actor, nowIso);
        targetBomId = Number(resInsert.lastInsertRowid);
      }

      const insertItem = db.prepare(
        'INSERT INTO bom_items (bom_id, component_part, qty_per_assembly, notes) VALUES (?, ?, ?, ?)'
      );
      for (const item of items) {
        insertItem.run(
          targetBomId,
          String(item.component_part).trim(),
          Number(item.qty_per_assembly),
          String(item.notes ?? '').trim()
        );
      }

      return targetBomId;
    });

    res.status(201).json({ id: bomId, parent_part: parentPart, revision });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to save BOM.' });
  }
});

app.delete('/api/bom/:id', requireAuth, requireRole(['admin', 'supervisor']), (req, res) => {
  const bomId = Number(req.params.id);
  const result = db.prepare('DELETE FROM boms WHERE id = ?').run(bomId);
  if (result.changes === 0) {
    res.status(404).json({ error: 'BOM not found.' });
    return;
  }
  res.json({ deleted: true, id: bomId });
});

// Uploaded Files (Excel / CSV Master Packing Lists)
app.get('/api/uploaded-files', requireAuth, (req, res) => {
  const companyId = Number(req.query.company_id);
  if (!companyId) {
    res.status(400).json({ error: 'company_id is required.' });
    return;
  }

  const files = db
    .prepare(
      'SELECT id, company_id, file_name, row_count, uploaded_by, uploaded_at FROM uploaded_files WHERE company_id = ? ORDER BY id DESC'
    )
    .all(companyId) as Array<{
    id: number;
    company_id: number;
    file_name: string;
    row_count: number;
    uploaded_by: string;
    uploaded_at: string;
  }>;

  const rowStmt = db.prepare(
    'SELECT id, file_id, company_id, lookup_key, part_name, part_number, qty, batch_ref FROM uploaded_file_rows WHERE file_id = ? ORDER BY id ASC'
  );

  const enriched = files.map((file) => ({
    ...file,
    rows: rowStmt.all(file.id),
  }));

  res.json({ files: enriched });
});

app.post('/api/uploaded-files', requireAuth, (req: AuthenticatedRequest, res) => {
  const companyId = Number(req.body?.company_id);
  const fileName = String(req.body?.file_name ?? '').trim();
  const rawRows = Array.isArray(req.body?.rows) ? req.body.rows : [];

  if (!companyId || !fileName) {
    res.status(400).json({ error: 'company_id and file_name are required.' });
    return;
  }
  if (rawRows.length === 0) {
    res.status(400).json({ error: 'Uploaded file contains no valid data rows.' });
    return;
  }

  const normalizedRows: Array<{
    lookup_key: string;
    part_name: string;
    part_number: string;
    qty: number;
    batch_ref: string;
  }> = [];

  for (let i = 0; i < rawRows.length; i++) {
    const r = rawRows[i];
    const lookupKey = String(r?.lookup_key ?? '').trim();
    const partName = String(r?.part_name ?? '').trim() || 'Part Item';
    const partNumber = String(r?.part_number ?? '').trim() || lookupKey;
    const qty = Math.floor(Number(r?.qty));
    const batchRef = String(r?.batch_ref ?? '').trim();

    if (!lookupKey || !partNumber || !Number.isInteger(qty) || qty <= 0) {
      res.status(400).json({
        error: `Invalid row ${i + 1}: Column A (Lookup Criteria), Column C (Part Number), and positive integer Column D (Qty) are required.`,
      });
      return;
    }

    normalizedRows.push({
      lookup_key: lookupKey,
      part_name: partName,
      part_number: partNumber,
      qty,
      batch_ref: batchRef,
    });
  }

  const actor = req.user!.username;
  const nowIso = new Date().toISOString();

  const created = withTransaction(() => {
    const fileRes = db
      .prepare(
        'INSERT INTO uploaded_files (company_id, file_name, row_count, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(companyId, fileName, normalizedRows.length, actor, nowIso);
    const fileId = Number(fileRes.lastInsertRowid);

    const insertRow = db.prepare(
      'INSERT INTO uploaded_file_rows (file_id, company_id, lookup_key, part_name, part_number, qty, batch_ref) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );

    for (const row of normalizedRows) {
      insertRow.run(
        fileId,
        companyId,
        row.lookup_key,
        row.part_name,
        row.part_number,
        row.qty,
        row.batch_ref
      );
    }

    const file = db
      .prepare('SELECT id, company_id, file_name, row_count, uploaded_by, uploaded_at FROM uploaded_files WHERE id = ?')
      .get(fileId) as Record<string, unknown>;
    const rows = db
      .prepare(
        'SELECT id, file_id, company_id, lookup_key, part_name, part_number, qty, batch_ref FROM uploaded_file_rows WHERE file_id = ? ORDER BY id ASC'
      )
      .all(fileId);

    return { ...file, rows };
  });

  res.status(201).json({ file: created });
});

app.delete('/api/uploaded-files/:id', requireAuth, (req, res) => {
  const fileId = Number(req.params.id);
  const result = db.prepare('DELETE FROM uploaded_files WHERE id = ?').run(fileId);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Uploaded file not found.' });
    return;
  }
  res.json({ deleted: true, id: fileId });
});

app.post('/api/receiving/lookup', requireAuth, (req, res) => {
  const companyId = Number(req.body?.company_id);
  const rawScan = String(req.body?.raw_scan ?? '');

  if (!companyId || !rawScan.trim()) {
    res.status(400).json({ error: 'company_id and raw_scan are required.' });
    return;
  }

  let cleaned = rawScan.replace(/[\r\n]+/g, '').trim();
  const aimMatch = cleaned.match(/^\]([A-Za-z][0-9A-Za-z])/);
  if (aimMatch) {
    cleaned = cleaned.slice(aimMatch[0].length).trim();
  }

  const cleanedUpper = cleaned.toUpperCase();
  const segmentsUpper = cleaned
    .split(/[\/_\\\s]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  const allRows = db
    .prepare(
      `SELECT r.id, r.file_id, r.company_id, r.lookup_key, r.part_name, r.part_number, r.qty, r.batch_ref,
              f.file_name
       FROM uploaded_file_rows r
       INNER JOIN uploaded_files f ON f.id = r.file_id
       WHERE r.company_id = ?
       ORDER BY r.file_id DESC, r.id ASC`
    )
    .all(companyId) as Array<{
    id: number;
    file_id: number;
    company_id: number;
    lookup_key: string;
    part_name: string;
    part_number: string;
    qty: number;
    batch_ref: string;
    file_name: string;
  }>;

  if (allRows.length === 0) {
    res.json({ matched: false, matchedKey: null, fileName: null, items: [] });
    return;
  }

  // Match priority: 1) exact full scan, 2) exact segment match, 3) longest substring match
  let matchedRow = allRows.find((r) => r.lookup_key.trim().toUpperCase() === cleanedUpper);

  if (!matchedRow) {
    for (const seg of segmentsUpper) {
      matchedRow = allRows.find((r) => r.lookup_key.trim().toUpperCase() === seg);
      if (matchedRow) break;
    }
  }

  if (!matchedRow) {
    const substringMatches = allRows
      .filter((r) => {
        const key = r.lookup_key.trim().toUpperCase();
        return key.length > 0 && cleanedUpper.includes(key);
      })
      .sort((a, b) => b.lookup_key.length - a.lookup_key.length || b.file_id - a.file_id);
    matchedRow = substringMatches[0];
  }

  if (!matchedRow) {
    res.json({ matched: false, matchedKey: null, fileName: null, items: [] });
    return;
  }

  const targetKeyUpper = matchedRow.lookup_key.trim().toUpperCase();
  const targetFileId = matchedRow.file_id;
  const matchedItems = allRows
    .filter((r) => r.file_id === targetFileId && r.lookup_key.trim().toUpperCase() === targetKeyUpper)
    .map(({ file_name: _fn, ...row }) => row);

  res.json({
    matched: true,
    matchedKey: matchedRow.lookup_key.trim(),
    fileName: matchedRow.file_name,
    items: matchedItems,
  });
});

// Users (Admin only)
app.get('/api/users', requireAuth, requireRole(['admin']), (_req, res) => {
  const users = db
    .prepare('SELECT id, username, full_name, role, active, created_at FROM users ORDER BY id ASC')
    .all();
  res.json({ users });
});

app.post('/api/users', requireAuth, requireRole(['admin']), (req, res) => {
  const username = String(req.body?.username ?? '').trim();
  const fullName = String(req.body?.full_name ?? '').trim();
  const password = String(req.body?.password ?? '');
  const role = String(req.body?.role ?? 'operator').trim() as UserRole;

  if (!username || !fullName || password.length < 6) {
    res.status(400).json({ error: 'username, full_name, and password (min 6 chars) are required.' });
    return;
  }
  if (!['admin', 'supervisor', 'operator'].includes(role)) {
    res.status(400).json({ error: 'role must be admin, supervisor, or operator.' });
    return;
  }

  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) {
    res.status(409).json({ error: `Username "${username}" already exists.` });
    return;
  }

  const hash = bcrypt.hashSync(password, 10);
  const result = db
    .prepare('INSERT INTO users (username, full_name, password_hash, role, active) VALUES (?, ?, ?, ?, 1)')
    .run(username, fullName, hash, role);

  res.status(201).json({
    id: Number(result.lastInsertRowid),
    username,
    full_name: fullName,
    role,
    active: 1,
  });
});

app.patch('/api/users/:id', requireAuth, requireRole(['admin']), (req: AuthenticatedRequest, res) => {
  const userId = Number(req.params.id);
  const existing = db.prepare('SELECT id, username, role, active FROM users WHERE id = ?').get(userId) as
    | { id: number; username: string; role: UserRole; active: number }
    | undefined;

  if (!existing) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }

  if (existing.id === req.user!.userId && req.body?.active === 0) {
    res.status(400).json({ error: 'Cannot deactivate your own active admin account.' });
    return;
  }

  const nextRole = req.body?.role && ['admin', 'supervisor', 'operator'].includes(req.body.role)
    ? req.body.role
    : existing.role;
  const nextActive = typeof req.body?.active === 'number' || typeof req.body?.active === 'boolean'
    ? (req.body.active ? 1 : 0)
    : existing.active;

  db.prepare('UPDATE users SET role = ?, active = ? WHERE id = ?').run(nextRole, nextActive, userId);
  res.json({ id: userId, role: nextRole, active: nextActive });
});

// Mount Vite in development or static dist in production
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Cloud WMS running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
