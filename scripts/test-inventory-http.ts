import express from 'express';
import { apiRouter, loadInventoryAppState } from '../src/server/apiRouter';
import { getPrismaClient } from '../src/server/db/prisma';
import { INITIAL_PARTS } from '../src/server/sampleData';

const prisma = getPrismaClient();
const nonce = `HTTP-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let coilId: string | undefined;
let contractId: string | undefined;
let server: import('node:http').Server | undefined;
const deliveryDocumentNumbers: string[] = [];
let finishedStockBefore: any = null;
let finishedPartId: string | undefined;
let finishedWarehouseId: string | undefined;
let finishedLocationId: string | undefined;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function requestJson(baseUrl: string, path: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function main() {
  assert(process.env.DATABASE_URL, 'DATABASE_URL is required for HTTP inventory integration tests.');

  const warehouse = await prisma.warehouse.findFirst({ where: { code: 'WH-RAW', active: true } });
  assert(warehouse, 'CI seed must contain the raw-material warehouse WH-RAW.');
  const [location, partCandidates, customer, mo] = await Promise.all([
    prisma.warehouseLocation.findFirst({ where: { code: 'LOC-RAW-A1', active: true, warehouseId: warehouse.id } }),
    prisma.part.findMany({
      where: { active: true, category: 'RAW_MATERIAL', materialId: { not: null }, partNumber: { in: INITIAL_PARTS.filter(p => p.unit === 'KG' && p.materialGrade).map(p => p.code) } },
      include: { unit: true, material: true },
    }),
    prisma.customer.findFirst({ where: { active: true } }),
    prisma.manufacturingOrder.findFirst({
      where: { status: 'IN_PROGRESS', operations: { some: { status: 'IN_PROGRESS' } } },
      include: { operations: { where: { status: 'IN_PROGRESS' }, orderBy: { stepNumber: 'asc' }, take: 1 } },
    }),
  ]);
  const dbPart = partCandidates.find(row => row.unit.code === 'KG' && row.material);
  assert(location && dbPart?.material && customer && mo?.operations[0], 'CI seed must contain LOC-RAW-A1, a KG raw material, a customer and an in-progress MO operation.');

  const appPart = INITIAL_PARTS.find(p => p.code === dbPart.partNumber);
  assert(appPart, `No application part mapping found for ${dbPart.partNumber}.`);

  const contract = await prisma.materialContract.create({
    data: {
      contractNumber: `${nonce}-CONTRACT`,
      supplierCustomerId: customer.id,
      title: 'HTTP inventory integration test contract',
      materialId: dbPart.materialId!,
      totalAllocatedWeightKg: 100,
      startDate: new Date(),
      endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });
  contractId = contract.id;

  try {
    await loadInventoryAppState();
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use('/api', apiRouter);

    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server!.once('listening', resolve);
      server!.once('error', reject);
    });
    const address = server.address();
    assert(address && typeof address === 'object', 'HTTP test server did not bind to an ephemeral port.');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const list = await requestJson(baseUrl, '/api/inventory/coils');
    assert(list.response.status === 200 && list.payload.success === true && Array.isArray(list.payload.data), 'GET /inventory/coils must return a successful JSON list.');
    console.log('PASS: HTTP GET inventory coils.');

    const invalidReceipt = await requestJson(baseUrl, '/api/inventory/coils', 'POST', {});
    assert(invalidReceipt.response.status === 400 && invalidReceipt.payload.success === false, 'Receipt endpoint must reject missing required fields with HTTP 400.');
    console.log('PASS: HTTP receipt validation.');

    const receipt = await requestJson(baseUrl, '/api/inventory/coils', 'POST', {
      coilId: `${nonce}-COIL`,
      coilPackNumber: `${nonce}-PACK`,
      partId: appPart.id,
      partCode: appPart.code,
      partName: appPart.name,
      materialGrade: dbPart.material!.grade,
      thicknessMm: Number(dbPart.thicknessMm || 1),
      widthMm: 1000,
      originalWeightKg: 100,
      remainingWeightKg: 100,
      warehouseId: 'WH-RAW',
      warehouseLocationCode: 'LOC-RAW-A1',
      ownership: 'SAPCO_SUPPLIER_OWNED',
      qualityStatus: 'AVAILABLE',
      physicalStatus: 'AVAILABLE',
      allocations: [],
    });
    assert(receipt.response.status === 201 && receipt.payload.success === true && receipt.payload.data?.id, `HTTP coil receipt failed: ${JSON.stringify(receipt.payload)}`);
    coilId = receipt.payload.data.id;
    console.log('PASS: HTTP POST receipt persists a physical coil and inventory receipt.');

    // Simulate the app's post-receipt refresh/reload, then verify the same PostgreSQL
    // receipt is exposed exactly once and contributes exactly once to displayed stock.
    await loadInventoryAppState();
    const [receiptDocuments, receiptStock] = await Promise.all([
      requestJson(baseUrl, `/api/inventory/documents?search=${encodeURIComponent(`${nonce}-COIL`)}`),
      requestJson(baseUrl, `/api/inventory/stock-inquiry?search=${encodeURIComponent(`${nonce}-COIL`)}`),
    ]);
    assert(
      receiptDocuments.response.status === 200 &&
        receiptDocuments.payload.success === true &&
        receiptDocuments.payload.data.filter((doc: any) =>
          doc.lines?.some((line: any) => line.lotNumber === `${nonce}-COIL`)
        ).length === 1,
      'A PostgreSQL coil receipt must appear as exactly one inventory document after app-state reload.'
    );
    const receiptStockRows = receiptStock.payload.data?.filter((row: any) => row.lotNumber === `${nonce}-COIL`) || [];
    const displayedReceiptKg = receiptStockRows.reduce((sum: number, row: any) => sum + Number(row.physicalKg || 0), 0);
    assert(
      receiptStock.response.status === 200 &&
        receiptStock.payload.success === true &&
        receiptStockRows.length === 1 &&
        displayedReceiptKg === 100,
      `A 100 kg coil receipt must appear exactly once in stock inquiry; got ${receiptStockRows.length} rows / ${displayedReceiptKg} kg.`
    );
    console.log('PASS: Receipt appears once in documents and adds exactly 100 kg to stock inquiry after reload.');
    const cardex = await requestJson(baseUrl, `/api/inventory/stock-inquiry/cardex?partCode=${encodeURIComponent(appPart.code)}`);
    const cardexReceiptRows = cardex.payload.data?.filter((row: any) => row.coilPackNumber === `${nonce}-PACK`) || [];
    assert(
      cardex.response.status === 200 &&
        cardex.payload.success === true &&
        cardex.payload.source === 'POSTGRESQL_INVENTORY_TRANSACTION_LEDGER' &&
        cardexReceiptRows.length === 1 &&
        Number(cardexReceiptRows[0].inKg) === 100 &&
        Number(cardexReceiptRows[0].runningBalanceKg) > 0,
      `Selected-part Cardex must expose the persisted PostgreSQL receipt transaction and its running weight balance: ${JSON.stringify(cardex.payload)}`
    );
    console.log('PASS: Selected-part Cardex reads the PostgreSQL transaction ledger and running balance.');

    const cardexMissingPart = await requestJson(baseUrl, '/api/inventory/stock-inquiry/cardex');
    assert(cardexMissingPart.response.status === 400 && cardexMissingPart.payload.success === false,
      'Cardex must reject requests without a part identifier.');
    console.log('PASS: Cardex requires an explicit part identifier.');


    const expectedThickness = Number(dbPart.thicknessMm || 1);
    const byPack = await requestJson(baseUrl, `/api/inventory/stock-inquiry?coilPackNumber=${encodeURIComponent(`${nonce}-PACK`)}`);
    assert(
      byPack.response.status === 200 &&
        byPack.payload.success === true &&
        byPack.payload.total === 1 &&
        byPack.payload.data?.[0]?.coilPackNumber === `${nonce}-PACK`,
      'Stock inquiry must filter by exact physical coil pack number.'
    );
    console.log('PASS: Stock inquiry exact coil-pack filter.');

    const byThickness = await requestJson(baseUrl, `/api/inventory/stock-inquiry?thicknessMm=${encodeURIComponent(String(expectedThickness))}&search=${encodeURIComponent(nonce)}`);
    assert(
      byThickness.response.status === 200 &&
        byThickness.payload.success === true &&
        byThickness.payload.total === 1 &&
        Number(byThickness.payload.data?.[0]?.thicknessMm) === expectedThickness,
      'Stock inquiry must filter by physical coil thickness and preserve the mapped thickness.'
    );
    console.log('PASS: Stock inquiry thickness filter.');
    const csvExportResponse = await fetch(`${baseUrl}/api/inventory/stock-inquiry/export?search=${encodeURIComponent(nonce)}`);
    const csvExportBody = await csvExportResponse.text();
    assert(
      csvExportResponse.status === 200 &&
        csvExportResponse.headers.get('content-type')?.includes('text/csv') &&
        csvExportResponse.headers.get('x-exported-row-count') === '1' &&
        csvExportBody.includes(`${nonce}-PACK`) &&
        csvExportBody.includes(appPart.code),
      `Filtered stock CSV must stream all matching PostgreSQL rows with a verifiable count: ${csvExportResponse.status}, ${csvExportResponse.headers.get('x-exported-row-count')}, ${csvExportBody.slice(0, 500)}`
    );
    console.log('PASS: Server-side CSV export streams the complete filtered stock inquiry.');


    const pagedReceipt = await requestJson(baseUrl, `/api/inventory/stock-inquiry?search=${encodeURIComponent(nonce)}&page=1&limit=1`);
    assert(
      pagedReceipt.response.status === 200 &&
        pagedReceipt.payload.success === true &&
        pagedReceipt.payload.total === 1 &&
        pagedReceipt.payload.page === 1 &&
        pagedReceipt.payload.pageSize === 1 &&
        pagedReceipt.payload.totalPages === 1 &&
        pagedReceipt.payload.data?.length === 1,
      'Stock inquiry pagination must return the filtered total and requested page metadata.'
    );
    console.log('PASS: Stock inquiry filtered pagination metadata.');
    const summary = await requestJson(baseUrl, `/api/inventory/stock-inquiry/summary?search=${encodeURIComponent(nonce)}`);
    assert(
      summary.response.status === 200 &&
        summary.payload.success === true &&
        summary.payload.data?.rowCount === pagedReceipt.payload.total &&
        Number(summary.payload.data?.physicalKg) === 100 &&
        Number(summary.payload.data?.availableKg) === 100,
      `Stock inquiry summary must aggregate the complete filtered result, not only the visible page: ${JSON.stringify(summary.payload)}`
    );
    console.log('PASS: Stock inquiry summary aggregates the complete filtered PostgreSQL result.');

    const facets = await requestJson(baseUrl, `/api/inventory/stock-inquiry/facets?search=${encodeURIComponent(nonce)}`);
    assert(
      facets.response.status === 200 &&
        facets.payload.success === true &&
        facets.payload.data?.coilPackNumbers?.includes(`${nonce}-PACK`) &&
        facets.payload.data?.thicknesses?.some((value: number) => Number(value) === expectedThickness),
      `Stock inquiry facets must include values outside any current table page: ${JSON.stringify(facets.payload)}`
    );
    console.log('PASS: Stock inquiry facets return coil-pack and thickness values independent of table pagination.');
    const groupedCoilPack = await requestJson(baseUrl, `/api/inventory/stock-inquiry/grouped?groupBy=COIL_PACK&search=${encodeURIComponent(nonce)}`);
    const groupedCoilPackRow = groupedCoilPack.payload.data?.find((row: any) => row.groupKey === `${nonce}-PACK`);
    assert(
      groupedCoilPack.response.status === 200 &&
        groupedCoilPack.payload.success === true &&
        groupedCoilPack.payload.source === 'POSTGRESQL_STOCK_BALANCE_GROUPS' &&
        groupedCoilPack.payload.totalRows === 1 &&
        groupedCoilPackRow?.rowCount === 1 &&
        groupedCoilPackRow?.coilsCount === 1 &&
        Number(groupedCoilPackRow?.totalPhysicalKg) === 100 &&
        Number(groupedCoilPackRow?.totalAvailableKg) === 100,
      `Grouped stock inquiry must calculate complete filtered coil-pack totals in PostgreSQL: ${JSON.stringify(groupedCoilPack.payload)}`
    );
    console.log('PASS: Grouped stock inquiry returns complete filtered coil-pack aggregates from PostgreSQL.');
    const expectedGroupKeys: Array<[string, string]> = [
      ['PART', dbPart.id],
      ['OWNERSHIP', 'SAPCO_SUPPLIER_OWNED'],
      ['GRADE', dbPart.material!.grade],
      ['THICKNESS', dbPart.thicknessMm == null ? 'NO_THICK' : String(Number(dbPart.thicknessMm))],
    ];
    for (const [groupByKey, expectedKey] of expectedGroupKeys) {
      const grouped = await requestJson(baseUrl, `/api/inventory/stock-inquiry/grouped?groupBy=${groupByKey}&search=${encodeURIComponent(nonce)}`);
      const row = grouped.payload.data?.find((entry: any) => entry.groupKey === expectedKey);
      assert(
        grouped.response.status === 200 &&
          grouped.payload.success === true &&
          grouped.payload.totalRows === 1 &&
          grouped.payload.totalGroups === 1 &&
          row?.rowCount === 1 &&
          Number(row?.totalPhysicalKg) === 100,
        `PostgreSQL grouped stock inquiry must aggregate ${groupByKey} correctly: ${JSON.stringify(grouped.payload)}`
      );
    }
    const groupedWarehouse = await requestJson(baseUrl, `/api/inventory/stock-inquiry/grouped?groupBy=WAREHOUSE&search=${encodeURIComponent(nonce)}`);
    assert(
      groupedWarehouse.response.status === 200 &&
        groupedWarehouse.payload.success === true &&
        groupedWarehouse.payload.totalGroups === 1 &&
        groupedWarehouse.payload.data?.[0]?.groupTitle === warehouse.name &&
        groupedWarehouse.payload.data?.[0]?.rowCount === 1 &&
        Number(groupedWarehouse.payload.data?.[0]?.totalPhysicalKg) === 100,
      `PostgreSQL warehouse grouping must aggregate the expected warehouse: ${JSON.stringify(groupedWarehouse.payload)}`
    );
    console.log('PASS: PostgreSQL GROUP BY aggregates part, ownership, grade and thickness groups.');
    const groupedCombinedFilters = await requestJson(baseUrl, `/api/inventory/stock-inquiry/grouped?groupBy=COIL_PACK&search=${encodeURIComponent(nonce)}&onlyAvailable=true&thicknessMm=${encodeURIComponent(String(expectedThickness))}`);
    assert(
      groupedCombinedFilters.response.status === 200 &&
        groupedCombinedFilters.payload.success === true &&
        groupedCombinedFilters.payload.totalRows === 1 &&
        groupedCombinedFilters.payload.data?.length === 1 &&
        groupedCombinedFilters.payload.data[0]?.groupKey === `${nonce}-PACK` &&
        Number(groupedCombinedFilters.payload.data[0]?.totalAvailableKg) === 100,
      `Grouped aggregate must preserve combined search, availability and thickness filters: ${JSON.stringify(groupedCombinedFilters.payload)}`
    );
    console.log('PASS: Grouped SQL aggregate honors combined search, availability and thickness filters.');



    const invalidGroupedInquiry = await requestJson(baseUrl, `/api/inventory/stock-inquiry/grouped?groupBy=INVALID&search=${encodeURIComponent(nonce)}`);
    assert(
      invalidGroupedInquiry.response.status === 400 && invalidGroupedInquiry.payload.success === false,
      'Grouped stock inquiry must reject unsupported grouping keys.'
    );
    console.log('PASS: Grouped stock inquiry validates the grouping key.');
    const groupedDetails = await requestJson(baseUrl, `/api/inventory/stock-inquiry/grouped?groupBy=COIL_PACK&detailsOnly=true&groupKey=${encodeURIComponent(`${nonce}-PACK`)}&search=${encodeURIComponent(nonce)}&page=1&limit=10`);
    assert(
      groupedDetails.response.status === 200 &&
        groupedDetails.payload.success === true &&
        groupedDetails.payload.source === 'POSTGRESQL_STOCK_BALANCE_GROUP_DETAILS' &&
        groupedDetails.payload.total === 1 &&
        groupedDetails.payload.page === 1 &&
        groupedDetails.payload.pageSize === 10 &&
        groupedDetails.payload.data?.length === 1 &&
        groupedDetails.payload.data[0]?.partId === dbPart.id &&
        Number(groupedDetails.payload.data[0]?.physicalKg) === 100,
      `Grouped stock inquiry details must be group-scoped and paginated: ${JSON.stringify(groupedDetails.payload)}`
    );
    console.log('PASS: Group details load from PostgreSQL with group scope and pagination.');

    const missingGroupKey = await requestJson(baseUrl, `/api/inventory/stock-inquiry/grouped?groupBy=COIL_PACK&detailsOnly=true&search=${encodeURIComponent(nonce)}`);
    assert(missingGroupKey.response.status === 400 && missingGroupKey.payload.success === false, 'Grouped detail endpoint must require a group key.');
    console.log('PASS: Group detail endpoint validates the group key.');



    const warehouseSummary = await requestJson(baseUrl, `/api/inventory/stock-inquiry/warehouse-summary?search=${encodeURIComponent(nonce)}`);
    const warehouseSummaryRow = warehouseSummary.payload.data?.find((row: any) => row.warehouseId === warehouse.id);
    assert(
      warehouseSummary.response.status === 200 &&
        warehouseSummary.payload.success === true &&
        Number(warehouseSummaryRow?.physicalKg) === 100 &&
        Number(warehouseSummaryRow?.lotsCount) === 1,
      `Warehouse summary must aggregate the full filtered stock once per warehouse: ${JSON.stringify(warehouseSummary.payload)}`
    );
    console.log('PASS: Warehouse summary aggregates physical stock and distinct lot count.');

    const partSummary = await requestJson(baseUrl, `/api/inventory/stock-inquiry/part-summary?search=${encodeURIComponent(nonce)}`);
    const partSummaryRow = partSummary.payload.data?.find((row: any) => row.partId === dbPart.id);
    assert(
      partSummary.response.status === 200 &&
        partSummary.payload.success === true &&
        Number(partSummaryRow?.rowCount) === 1 &&
        Number(partSummaryRow?.physicalKg) === 100 &&
        Number(partSummaryRow?.availableKg) === 100 &&
        Number(partSummaryRow?.physicalQty) === 100 &&
        partSummaryRow?.locationsSummary?.includes(warehouse.name),
      `Part summary must return available stock and locations for reorder calculations: ${JSON.stringify(partSummary.payload)}`
    );
    console.log('PASS: Part summary returns complete available stock and warehouse locations.');

    const invalidSummaryFilter = await requestJson(baseUrl, '/api/inventory/stock-inquiry/summary?thicknessMm=0');
    assert(invalidSummaryFilter.response.status === 400 && invalidSummaryFilter.payload.success === false, 'Stock inquiry summary must reject invalid shared filters.');
    console.log('PASS: Stock inquiry summary validates filters with the same rules as the list.');


    const invalidThickness = await requestJson(baseUrl, '/api/inventory/stock-inquiry?thicknessMm=0');
    assert(
      invalidThickness.response.status === 400 && invalidThickness.payload.success === false,
      'Stock inquiry must reject non-positive thickness filters.'
    );
    console.log('PASS: Stock inquiry rejects invalid thickness filters.');

    const invalidAllocation = await requestJson(baseUrl, `/api/inventory/coils/${coilId}/allocate`, 'POST', { allocations: [] });
    assert(invalidAllocation.response.status === 400, 'Allocation endpoint must reject an empty allocation list with HTTP 400.');

    const allocation = await requestJson(baseUrl, `/api/inventory/coils/${coilId}/allocate`, 'POST', {
      allocations: [{ contractId: contract.id, contractNumber: contract.contractNumber, allocatedWeightKg: 100 }],
    });
    assert(allocation.response.status === 200 && allocation.payload.success === true, `HTTP contract allocation failed: ${JSON.stringify(allocation.payload)}`);
    console.log('PASS: HTTP POST contract allocation.');

    const invalidIssue = await requestJson(baseUrl, `/api/inventory/coils/${coilId}/issue`, 'POST', {
      issueRequestKey: `${nonce}-INVALID-ISSUE-1`,
      issuedWeightKg: 0,
      moId: mo.moNumber,
      moOperationId: mo.operations[0].id,
    });
    assert(invalidIssue.response.status === 400, 'Issue endpoint must reject zero issue weight with HTTP 400.');

    const issue = await requestJson(baseUrl, `/api/inventory/coils/${coilId}/issue`, 'POST', {
      issueRequestKey: `${nonce}-ISSUE-HTTP-1`,
      issuedWeightKg: 20,
      moId: mo.moNumber,
      moOperationId: mo.operations[0].id,
      partId: mo.partId,
      scrappedKg: 0,
    });
    assert(issue.response.status === 200 && issue.payload.success === true, `HTTP manufacturing issue failed: ${JSON.stringify(issue.payload)}`);
    console.log('PASS: HTTP POST issue links material consumption to a manufacturing order and operation.');

    const actualConsumption = await requestJson(
      baseUrl,
      `/api/reports/material-consumption-actual?partId=${encodeURIComponent(mo.partId)}`,
    );
    assert(actualConsumption.response.status === 200 && actualConsumption.payload.success === true, `Actual consumption report failed: ${JSON.stringify(actualConsumption.payload)}`);
    const actualRow = actualConsumption.payload.data?.find((row: any) =>
      row.moNumber === mo.moNumber && row.materialCode === appPart.code && row.coilNumbers?.includes(`${nonce}-COIL`)
    );
    assert(actualRow && Number(actualRow.actualIssuedMaterialKg) >= 20, 'Actual consumption report must expose the posted 20 kg issue with its MO and coil genealogy.');
    assert(Array.isArray(actualRow.actualMachineNames) && Array.isArray(actualRow.actualOperatorNames), 'Actual consumption report must expose actual machine/operator fields, even when no production report is yet linked.');
    const disabledBomVariance = await requestJson(baseUrl, '/api/reports/material-consumption-vs-standard');
    assert(disabledBomVariance.response.status === 409 && disabledBomVariance.payload.source === 'BOM_VARIANCE_DISABLED_UNTIL_VERSIONED_BOM_RECONCILIATION', 'BOM variance endpoint must not return sample estimates before versioned BOM reconciliation.');
    console.log('PASS: HTTP actual-consumption report uses posted issue ledger and disables unverified BOM variance.');

    const invalidReturn = await requestJson(baseUrl, `/api/inventory/coils/${coilId}/return`, 'POST', { returnedRemnantWeightKg: 0 });
    assert(invalidReturn.response.status === 400, 'Return endpoint must reject zero returned weight with HTTP 400.');

    const returned = await requestJson(baseUrl, `/api/inventory/coils/${coilId}/return`, 'POST', {
      returnedRemnantWeightKg: 5,
      warehouseId: 'WH-RAW',
      locationCode: 'LOC-RAW-A1',
      notes: 'HTTP integration test partial remnant return',
    });
    assert(returned.response.status === 200 && returned.payload.success === true, `HTTP remnant return failed: ${JSON.stringify(returned.payload)}`);
    console.log('PASS: HTTP POST partial remnant return.');

    // Exercise the actual HTTP route with two simultaneous returns against 15 kg outstanding.
    const concurrentReturns = await Promise.all([
      requestJson(baseUrl, `/api/inventory/coils/${coilId}/return`, 'POST', {
        returnedRemnantWeightKg: 10,
        warehouseId: 'WH-RAW',
        locationCode: 'LOC-RAW-A1',
        notes: 'HTTP concurrent return A',
      }),
      requestJson(baseUrl, `/api/inventory/coils/${coilId}/return`, 'POST', {
        returnedRemnantWeightKg: 10,
        warehouseId: 'WH-RAW',
        locationCode: 'LOC-RAW-A1',
        notes: 'HTTP concurrent return B',
      }),
    ]);
    const acceptedReturns = concurrentReturns.filter(row => row.response.status === 200 && row.payload.success === true);
    const rejectedReturns = concurrentReturns.filter(row => row.response.status === 409 && row.payload.success === false);
    assert(acceptedReturns.length === 1 && rejectedReturns.length === 1, `Two concurrent 10 kg HTTP returns against 15 kg outstanding must yield one success and one conflict; got statuses ${concurrentReturns.map(row => row.response.status).join(', ')}.`);
    console.log('PASS: HTTP concurrent partial returns accept exactly one request and reject the competing stale request.');

    const [coil, lot, balances, issueRecords] = await Promise.all([
      prisma.physicalCoil.findUnique({ where: { id: coilId } }),
      prisma.materialLot.findFirst({ where: { lotNumber: `${nonce}-COIL` } }),
      prisma.stockBalance.findMany({ where: { physicalCoilId: coilId } }),
      prisma.coilIssueReturnRecord.findMany({ where: { coilId, issuedWeightKg: { gt: 0 } } }),
    ]);
    const balanceKg = balances.reduce((sum, row) => sum + Number(row.weightKgOnHand), 0);
    assert(Number(coil?.remainingWeightKg) === 95, `Expected coil balance 95 kg after concurrent return, got ${coil?.remainingWeightKg}.`);
    assert(Number(lot?.remainingWeightKg) === 95, `Expected material lot balance 95 kg, got ${lot?.remainingWeightKg}.`);
    assert(balanceKg === 95, `Expected stock ledger balance 95 kg, got ${balanceKg}.`);
    assert(issueRecords.length > 0 && Number(issueRecords[0].outstandingWeightKg) === 5 && Number(issueRecords[0].returnedWeightKg) === 15, 'Issue/return genealogy must reconcile to 5 kg outstanding and 15 kg returned.');
    console.log('PASS: HTTP lifecycle reconciles coil, lot, stock ledger and issue/return genealogy to 95 kg after concurrent returns.');

    // Extend the material lifecycle through finished-goods receipt and customer delivery.
    const [finishedPart, finishedWarehouse, finishedLocation] = await Promise.all([
      prisma.part.findUnique({ where: { id: mo.partId }, include: { unit: true } }),
      prisma.warehouse.findFirst({ where: { code: 'WH-FINISHED', active: true } }),
      prisma.warehouseLocation.findFirst({ where: { code: 'LOC-FIN-P1', active: true } }),
    ]);
    assert(finishedPart && finishedWarehouse && finishedLocation && finishedLocation.warehouseId === finishedWarehouse.id,
      'CI seed must contain the manufacturing-order finished part and the canonical finished-goods warehouse/location.');
    const finishedAppPart = INITIAL_PARTS.find(part => part.code === finishedPart.partNumber);
    assert(finishedAppPart, `No application part mapping found for finished part ${finishedPart.partNumber}.`);
    finishedPartId = finishedPart.id;
    finishedWarehouseId = finishedWarehouse.id;
    finishedLocationId = finishedLocation.id;
    finishedStockBefore = await prisma.stockBalance.findFirst({
      where: {
        partId: finishedPart.id,
        warehouseId: finishedWarehouse.id,
        locationId: finishedLocation.id,
        ownership: 'COMPANY_OWNED',
        qualityStatus: 'AVAILABLE',
        contractId: null,
        materialLotId: null,
      },
    });
    const finishedQtyBefore = Number(finishedStockBefore?.quantityOnHand || 0);
    const finishedWeightPerUnitKg = Number(finishedPart.weightNetKg || 1);
    const receiptDocumentNumber = `${nonce}-FG-RECEIPT`;
    const deliveryDocumentNumber = `${nonce}-CUSTOMER-DELIVERY`;

    const finishedReceipt = await requestJson(baseUrl, '/api/inventory/documents', 'POST', {
      documentNumber: receiptDocumentNumber,
      documentType: 'RECEIPT_FINISHED_GOODS',
      warehouseId: 'WH-FINISHED',
      ownership: 'COMPANY_OWNED',
      referenceType: 'WIP_FINAL_OPERATION',
      referenceNumber: mo.moNumber,
      autoPost: true,
      user: { uid: 'CI-INVENTORY-TEST', displayName: 'CI inventory lifecycle test' },
      lines: [{
        partId: finishedAppPart.id,
        partCode: finishedAppPart.code,
        partName: finishedAppPart.name,
        quantity: 10,
        quantityKg: Number((10 * finishedWeightPerUnitKg).toFixed(3)),
        locationCode: 'LOC-FIN-P1',
        qualityStatus: 'AVAILABLE',
        ownership: 'COMPANY_OWNED',
      }],
    });
    assert(finishedReceipt.response.status === 201 && finishedReceipt.payload.success === true,
      `Finished-goods receipt must post to PostgreSQL: ${JSON.stringify(finishedReceipt.payload)}`);
    deliveryDocumentNumbers.push(receiptDocumentNumber);
    console.log('PASS: Final-operation finished-goods receipt posts to PostgreSQL.');

    const customerDelivery = await requestJson(baseUrl, '/api/inventory/documents', 'POST', {
      documentNumber: deliveryDocumentNumber,
      documentType: 'DELIVERY_CUSTOMER',
      warehouseId: 'WH-FINISHED',
      ownership: 'COMPANY_OWNED',
      referenceType: 'CUSTOMER',
      referenceNumber: customer.code,
      autoPost: true,
      user: { uid: 'CI-INVENTORY-TEST', displayName: 'CI inventory lifecycle test' },
      lines: [{
        partId: finishedAppPart.id,
        partCode: finishedAppPart.code,
        partName: finishedAppPart.name,
        quantity: 3,
        quantityKg: Number((3 * finishedWeightPerUnitKg).toFixed(3)),
        locationCode: 'LOC-FIN-P1',
        qualityStatus: 'AVAILABLE',
        ownership: 'COMPANY_OWNED',
        notes: `Customer: ${customer.name}`,
      }],
    });
    assert(customerDelivery.response.status === 201 && customerDelivery.payload.success === true,
      `Customer delivery must post to PostgreSQL: ${JSON.stringify(customerDelivery.payload)}`);
    deliveryDocumentNumbers.push(deliveryDocumentNumber);
    const [finishedStockAfter, deliveryTransactions, persistedDelivery] = await Promise.all([
      prisma.stockBalance.findFirst({
        where: {
          partId: finishedPart.id,
          warehouseId: finishedWarehouse.id,
          locationId: finishedLocation.id,
          ownership: 'COMPANY_OWNED',
          qualityStatus: 'AVAILABLE',
          contractId: null,
          materialLotId: null,
        },
      }),
      prisma.inventoryTransaction.findMany({
        where: { document: { documentNumber: deliveryDocumentNumber } },
      }),
      prisma.inventoryDocument.findUnique({
        where: { documentNumber: deliveryDocumentNumber },
        include: { transactions: true },
      }),
    ]);
    assert(Number(finishedStockAfter?.quantityOnHand) - finishedQtyBefore === 7,
      `Finished-goods balance must increase by 10 and decrease by 3; expected net +7, got ${Number(finishedStockAfter?.quantityOnHand) - finishedQtyBefore}.`);
    assert(deliveryTransactions.length === 1 &&
      Number(deliveryTransactions[0].quantitySigned) === -3 &&
      Number(deliveryTransactions[0].weightKgSigned) === -Number((3 * finishedWeightPerUnitKg).toFixed(3)),
      `Customer delivery must create one negative PostgreSQL ledger movement: ${JSON.stringify(deliveryTransactions)}`);
    assert(persistedDelivery?.postingStatus === 'POSTED' &&
      persistedDelivery.transactions.length === 1 &&
      persistedDelivery.referenceNumber === customer.code,
      'Customer delivery document, customer reference and its posted transaction must persist together in PostgreSQL.');
    console.log('PASS: Customer delivery deducts finished goods and persists a negative PostgreSQL ledger movement.');
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    if (deliveryDocumentNumbers.length) {
      const testDocuments = await prisma.inventoryDocument.findMany({
        where: { documentNumber: { in: deliveryDocumentNumbers } },
        select: { id: true },
      });
      const testDocumentIds = testDocuments.map(row => row.id);
      if (testDocumentIds.length) {
        await prisma.inventoryTransaction.deleteMany({ where: { documentId: { in: testDocumentIds } } });
        await prisma.inventoryDocumentLine.deleteMany({ where: { documentId: { in: testDocumentIds } } });
        await prisma.inventoryDocument.deleteMany({ where: { id: { in: testDocumentIds } } });
      }
      if (finishedStockBefore && finishedPartId && finishedWarehouseId && finishedLocationId) {
        await prisma.stockBalance.update({
          where: { id: finishedStockBefore.id },
          data: {
            quantityOnHand: finishedStockBefore.quantityOnHand,
            quantityReserved: finishedStockBefore.quantityReserved,
            quantityAvailable: finishedStockBefore.quantityAvailable,
            weightKgOnHand: finishedStockBefore.weightKgOnHand,
            weightKgReserved: finishedStockBefore.weightKgReserved,
            weightKgAvailable: finishedStockBefore.weightKgAvailable,
            lastTransactionAt: finishedStockBefore.lastTransactionAt,
          },
        });
      } else if (finishedPartId && finishedWarehouseId && finishedLocationId) {
        await prisma.stockBalance.deleteMany({
          where: {
            partId: finishedPartId,
            warehouseId: finishedWarehouseId,
            locationId: finishedLocationId,
            ownership: 'COMPANY_OWNED',
            qualityStatus: 'AVAILABLE',
            contractId: null,
            materialLotId: null,
          },
        });
      }
    }
    if (coilId) {
      const documents = await prisma.inventoryDocument.findMany({ where: { lines: { some: { physicalCoilId: coilId } } }, select: { id: true } });
      await prisma.inventoryTransaction.deleteMany({ where: { physicalCoilId: coilId } });
      await prisma.inventoryDocumentLine.deleteMany({ where: { physicalCoilId: coilId } });
      await prisma.coilIssueReturnRecord.deleteMany({ where: { coilId } });
      await prisma.stockBalance.deleteMany({ where: { physicalCoilId: coilId } });
      await prisma.contractCoilAllocation.deleteMany({ where: { coilId } });
      if (documents.length) await prisma.inventoryDocument.deleteMany({ where: { id: { in: documents.map(row => row.id) } } });
      await prisma.physicalCoil.deleteMany({ where: { id: coilId } });
    }
    if (coilId) await prisma.materialLot.deleteMany({ where: { lotNumber: `${nonce}-COIL` } });
    if (contractId) {
      await prisma.materialContractTransaction.deleteMany({ where: { contractId } });
      await prisma.materialContract.deleteMany({ where: { id: contractId } });
    }
    // Rehydrate the in-memory document store after deleting the test-only documents.
    await loadInventoryAppState();
    await prisma.$disconnect();
  }
}

main().catch(error => {
  console.error('HTTP inventory integration test failed:', error);
  process.exitCode = 1;
});
