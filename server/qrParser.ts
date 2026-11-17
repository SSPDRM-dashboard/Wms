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

const AIM_PREFIX_REGEX = /^\]([A-Za-z][0-9A-Za-z])/;

export function parseQrScan(companyId: number, rawInput: string): ParsedQrResult {
  const trimmed = (rawInput || '').trim();
  let cleaned = trimmed;
  let strippedAimPrefix: string | null = null;

  const aimMatch = trimmed.match(AIM_PREFIX_REGEX);
  if (aimMatch) {
    strippedAimPrefix = aimMatch[0];
    cleaned = trimmed.slice(strippedAimPrefix.length).trim();
  }

  if (!cleaned) {
    return {
      valid: false,
      companyId,
      profile: companyId === 1 ? 'underscore_v1' : 'slash_box_pallet_v1',
      rawInput,
      cleanedInput: cleaned,
      strippedAimPrefix,
      kind: 'invalid',
      addsInventory: false,
      partNumber: null,
      qty: null,
      boxId: null,
      batchRef: null,
      palletRef: null,
      segments: [],
      message: 'Empty scan input.',
    };
  }

  // Detect multi-part packing list QRs separated by semicolons (;) or newlines (\n)
  const lines = rawInput.split(/[\r\n;]+/).map((s) => s.trim()).filter(Boolean);
  if (lines.length > 1) {
    const subItems: Array<{ partNumber: string; qty: number; boxId: string; batchRef: string }> = [];
    let allValid = true;
    for (const line of lines) {
      const subRes = parseQrScan(companyId, line);
      if (subRes.valid && subRes.kind === 'box_inventory' && subRes.partNumber && subRes.qty && subRes.boxId) {
        subItems.push({
          partNumber: subRes.partNumber,
          qty: subRes.qty,
          boxId: subRes.boxId,
          batchRef: subRes.batchRef || '',
        });
      } else {
        allValid = false;
        break;
      }
    }
    if (allValid && subItems.length > 1) {
      return {
        valid: true,
        companyId,
        profile: companyId === 1 ? 'underscore_v1' : 'slash_box_pallet_v1',
        rawInput,
        cleanedInput: cleaned,
        strippedAimPrefix,
        kind: 'packing_list',
        addsInventory: true,
        partNumber: subItems[0].partNumber,
        qty: subItems.reduce((sum, i) => sum + i.qty, 0),
        boxId: subItems[0].boxId,
        batchRef: subItems[0].batchRef,
        palletRef: null,
        items: subItems,
        segments: lines,
        message: `Parsed packing list with ${subItems.length} different parts (${subItems.reduce((sum, i) => sum + i.qty, 0)} total units).`,
      };
    }
  }

  if (companyId === 1) {
    // Company A: split by `_`
    // segment 2 (idx 1) = part number
    // segment 4 (idx 3) = quantity
    // segment 5 (idx 4) = box
    // segment 6 (idx 5) = optional batch/reference
    const segments = cleaned.split('_');
    if (segments.length < 5) {
      return {
        valid: false,
        companyId,
        profile: 'underscore_v1',
        rawInput,
        cleanedInput: cleaned,
        strippedAimPrefix,
        kind: 'invalid',
        addsInventory: false,
        partNumber: null,
        qty: null,
        boxId: null,
        batchRef: null,
        palletRef: null,
        segments,
        message: `COMP-B-SAIC QR requires at least 5 "_" segments (received ${segments.length}). Expected: <prefix>_<part>_<field3>_<qty>_<box>[_<batch>]`,
      };
    }

    const partNumber = (segments[1] || '').trim();
    const qtyRaw = (segments[3] || '').trim();
    const boxId = (segments[4] || '').trim();
    const batchRef = (segments[5] || '').trim();
    const qty = Number(qtyRaw);

    if (!partNumber) {
      return {
        valid: false,
        companyId,
        profile: 'underscore_v1',
        rawInput,
        cleanedInput: cleaned,
        strippedAimPrefix,
        kind: 'invalid',
        addsInventory: false,
        partNumber: null,
        qty: null,
        boxId: null,
        batchRef: null,
        palletRef: null,
        segments,
        message: 'Segment 2 (Part Number) is empty.',
      };
    }

    if (!Number.isInteger(qty) || qty <= 0) {
      return {
        valid: false,
        companyId,
        profile: 'underscore_v1',
        rawInput,
        cleanedInput: cleaned,
        strippedAimPrefix,
        kind: 'invalid',
        addsInventory: false,
        partNumber,
        qty: null,
        boxId,
        batchRef: batchRef || null,
        palletRef: null,
        segments,
        message: `Segment 4 (Quantity) must be a positive integer; got "${qtyRaw}".`,
      };
    }

    if (!boxId) {
      return {
        valid: false,
        companyId,
        profile: 'underscore_v1',
        rawInput,
        cleanedInput: cleaned,
        strippedAimPrefix,
        kind: 'invalid',
        addsInventory: false,
        partNumber,
        qty,
        boxId: null,
        batchRef: batchRef || null,
        palletRef: null,
        segments,
        message: 'Segment 5 (Box ID) is empty.',
      };
    }

    return {
      valid: true,
      companyId,
      profile: 'underscore_v1',
      rawInput,
      cleanedInput: cleaned,
      strippedAimPrefix,
      kind: 'box_inventory',
      addsInventory: true,
      partNumber,
      qty,
      boxId,
      batchRef: batchRef || null,
      palletRef: null,
      segments,
      message: `Parsed COMP-B-SAIC box ${boxId}: ${qty} x ${partNumber}`,
    };
  }

  // Company B: split by `/`
  // Pallet QR: recognized as pallet reference only and does not create inventory
  // Box QR: segment 2 (idx 1) = part&qty, segment 3 (idx 2) = batch, segment 4 (idx 3) = box
  const segments = cleaned.split('/');
  const firstUpper = (segments[0] || '').trim().toUpperCase();
  const seg2 = (segments[1] || '').trim();

  const isPallet =
    firstUpper === 'PLT' ||
    firstUpper === 'PALLET' ||
    firstUpper.startsWith('PAL-') ||
    (segments.length >= 2 && !seg2.includes('&') && (firstUpper.includes('PLT') || firstUpper.includes('PALLET')));

  if (isPallet) {
    const palletRef = (segments[1] || segments[0] || cleaned).trim();
    return {
      valid: true,
      companyId,
      profile: 'slash_box_pallet_v1',
      rawInput,
      cleanedInput: cleaned,
      strippedAimPrefix,
      kind: 'pallet_reference',
      addsInventory: false,
      partNumber: null,
      qty: null,
      boxId: null,
      batchRef: null,
      palletRef,
      segments,
      message: `Pallet reference "${palletRef}" recorded. Scan individual box QR codes to stage stock.`,
    };
  }

  if (segments.length < 4) {
    return {
      valid: false,
      companyId,
      profile: 'slash_box_pallet_v1',
      rawInput,
      cleanedInput: cleaned,
      strippedAimPrefix,
      kind: 'invalid',
      addsInventory: false,
      partNumber: null,
      qty: null,
      boxId: null,
      batchRef: null,
      palletRef: null,
      segments,
      message: `COMP-A-GWM Box QR requires at least 4 "/" segments (received ${segments.length}). Expected: <prefix>/<part>&<qty>/<batch>/<box>`,
    };
  }

  if (!seg2.includes('&')) {
    return {
      valid: false,
      companyId,
      profile: 'slash_box_pallet_v1',
      rawInput,
      cleanedInput: cleaned,
      strippedAimPrefix,
      kind: 'invalid',
      addsInventory: false,
      partNumber: null,
      qty: null,
      boxId: null,
      batchRef: null,
      palletRef: null,
      segments,
      message: `Segment 2 must contain "<part>&<qty>" separated by "&"; got "${seg2}".`,
    };
  }

  const [partRaw, qtyRaw] = seg2.split('&');
  const partNumber = (partRaw || '').trim();
  const qty = Number((qtyRaw || '').trim());
  const batchRef = (segments[2] || '').trim();
  const boxId = (segments[3] || '').trim();

  if (!partNumber) {
    return {
      valid: false,
      companyId,
      profile: 'slash_box_pallet_v1',
      rawInput,
      cleanedInput: cleaned,
      strippedAimPrefix,
      kind: 'invalid',
      addsInventory: false,
      partNumber: null,
      qty: null,
      boxId,
      batchRef: batchRef || null,
      palletRef: null,
      segments,
      message: 'Part number before "&" in segment 2 is empty.',
    };
  }

  if (!Number.isInteger(qty) || qty <= 0) {
    return {
      valid: false,
      companyId,
      profile: 'slash_box_pallet_v1',
      rawInput,
      cleanedInput: cleaned,
      strippedAimPrefix,
      kind: 'invalid',
      addsInventory: false,
      partNumber,
      qty: null,
      boxId,
      batchRef: batchRef || null,
      palletRef: null,
      segments,
      message: `Quantity after "&" in segment 2 must be a positive integer; got "${qtyRaw}".`,
    };
  }

  if (!boxId) {
    return {
      valid: false,
      companyId,
      profile: 'slash_box_pallet_v1',
      rawInput,
      cleanedInput: cleaned,
      strippedAimPrefix,
      kind: 'invalid',
      addsInventory: false,
      partNumber,
      qty,
      boxId: null,
      batchRef: batchRef || null,
      palletRef: null,
      segments,
      message: 'Segment 4 (Box ID) is empty.',
    };
  }

  return {
    valid: true,
    companyId,
    profile: 'slash_box_pallet_v1',
    rawInput,
    cleanedInput: cleaned,
    strippedAimPrefix,
    kind: 'box_inventory',
    addsInventory: true,
    partNumber,
    qty,
    boxId,
    batchRef: batchRef || null,
    palletRef: null,
    segments,
    message: `Parsed COMP-A-GWM box ${boxId}: ${qty} x ${partNumber}`,
  };
}
