# Firestore Security Specification — NexusWMS

## 1. Data Invariants
1. **Authenticated Active Member Gate**: Every operational warehouse read and write requires a signed-in Firebase Auth user whose `/users/{uid}` profile exists and has `active == 1` (or verified admin status).
2. **Closed Account Provisioning**: After one-time `/system/bootstrap` initialization, self-registration is blocked; only authenticated administrators (`/admins/{uid}`) may provision new `/users/{uid}` accounts.
3. **Immutable Audit Trail**: `movements` are append-only (`update` and `delete` always denied).
4. **No Direct Lot Deletion**: `inventory_lots` and `containers` cannot be deleted via client writes (`allow delete: if false`); stock reductions only occur via valid FIFO outbound or transfer updates where `qty >= 0` and immutable fields (`company_id`, `part_number`, `initial_qty`, `box_id`, `container_id`, `received_at`, `createdByUid`) remain unchanged.
5. **Relational Integrity**:
   - Creating an `inventory_lot` with `container_id > 0` requires the parent `/containers/{containerId}` document to exist (`existsAfter(...)` inside atomic batch/transaction).
   - Creating a `/boms/{bomId}/items/{itemId}` requires parent `/boms/{bomId}` to exist (`existsAfter(...)` or `exists(...)`).
   - Creating an `/uploaded_files/{fileId}/rows/{rowId}` requires parent `/uploaded_files/{fileId}` to exist (`existsAfter(...)` or `exists(...)`).
6. **Privilege Escalation Prevention**: Non-admin users cannot create `/users/{uid}` or `/admins/{uid}` once `/system/bootstrap` exists, and cannot modify `role` or `active`.
7. **Strict Query Scoping**: Every `allow list` validates `resource.data` directly (no `get()`/`exists()` inside `allow list`).

## 2. Dirty Dozen Payloads (Must Return PERMISSION_DENIED)
1. **Unauthenticated read** on `/inventory_lots/1001` (`request.auth == null`).
2. **Unauthorized signup write** on `/users/{uid}` after `/system/bootstrap` exists.
3. **Duplicate bootstrap attack** attempting to overwrite or recreate `/system/bootstrap`.
4. **User role escalation update**: Non-admin user updates `/users/{uid}` changing `role` to `'admin'`.
5. **Shadow / ghost field injection**: Creating `/inventory_lots/1001` with extra field `isBypassed: true` (`keys().hasOnly(...)` rejects).
6. **Identity spoofing**: Creating `/movements/1001` with `createdByUid != request.auth.uid`.
7. **Timestamp forgery**: Creating `/containers/1001` with `serverCreatedAt` set to a client-chosen past date instead of `request.time`.
8. **Negative stock poisoning**: Updating `/inventory_lots/1001` with `qty: -5`.
9. **Immutable field tampering**: Updating `/inventory_lots/1001` changing `part_number` or `initial_qty` or `received_at`.
10. **Ledger tampering / deletion**: Attempting `update` or `delete` on `/movements/1001`.
11. **Oversized ID poisoning**: Accessing `/inventory_lots/{200-char-id}` or invalid characters (`isValidId` rejects).
12. **Operator BOM modification**: User with `role == 'operator'` creating or deleting `/boms/1001` (requires `supervisor` or `admin`).
