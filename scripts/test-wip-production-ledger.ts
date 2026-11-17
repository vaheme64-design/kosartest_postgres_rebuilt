import { getPrismaClient } from '../src/server/db/prisma';
import { postWipProductionAtomically } from '../src/server/wipProductionLedger';
import { postDocumentInDbTransaction } from '../src/server/inventoryEngine';

function assert(description: string, condition: boolean) {
  if (!condition) throw new Error(`❌ ${description}`);
  console.log(`✅ ${description}`);
}

async function run() {
  const prisma = getPrismaClient();
  const wipMoId = 'WIP-LEDGER-INTEGRATION-TEST';
  const idempotencyKey = 'test-wip-ledger-atomic-980-20';
  const rollbackKey = 'test-wip-ledger-rollback-001';
  const deliveryDocumentNumber = 'WIP-LEDGER-CUSTOMER-DELIVERY-TEST';
  const testOwnership = 'WIP_LEDGER_TEST';
  const testContractId = 'WIP-LEDGER-INTEGRATION-TEST';

  let originalSnapshot: any = null;
  let originalSnapshotVersion = 1;
  let hadSnapshot = false;
  let snapshotCaptured = false;
  let relationalOrder: any;
  let operation10: any;
  let operation20: any;
  let sourceLocation: any;
  let targetLocation: any;
  let scrapLocation: any;
  let part: any;
  let shift: any;
  let user: any;
  let originalMoValues: any;
  let originalOperationValues: any;
  let originalFinalOperationValues: any;

  try {
    // Clean leftovers from an interrupted run of this dedicated CI fixture.
    const stale = await prisma.productionReport.findMany({
      where: { wipIdempotencyKey: { in: [idempotencyKey, rollbackKey] } },
      select: { id: true },
    });
    if (stale.length) {
      await prisma.inventoryTransaction.deleteMany({ where: { productionReportId: { in: stale.map((row: any) => row.id) } } });
      await prisma.productionReport.deleteMany({ where: { id: { in: stale.map((row: any) => row.id) } } });
    }
    const staleDelivery = await prisma.inventoryDocument.findUnique({
      where: { documentNumber: deliveryDocumentNumber },
      select: { id: true },
    });
    if (staleDelivery) {
      await prisma.inventoryTransaction.deleteMany({ where: { documentId: staleDelivery.id } });
      await prisma.inventoryDocumentLine.deleteMany({ where: { documentId: staleDelivery.id } });
      await prisma.auditLog.deleteMany({ where: { entityName: 'InventoryDocument', entityId: staleDelivery.id } });
      await prisma.inventoryDocument.deleteMany({ where: { id: staleDelivery.id } });
    }
    const deliveryDoc = await prisma.inventoryDocument.findUnique({
      where: { documentNumber: deliveryDocumentNumber },
      select: { id: true },
    });
    if (deliveryDoc) {
      await prisma.inventoryTransaction.deleteMany({ where: { documentId: deliveryDoc.id } });
      await prisma.inventoryDocumentLine.deleteMany({ where: { documentId: deliveryDoc.id } });
      await prisma.auditLog.deleteMany({ where: { entityName: 'InventoryDocument', entityId: deliveryDoc.id } });
      await prisma.inventoryDocument.deleteMany({ where: { id: deliveryDoc.id } });
    }
    await prisma.wipManufacturingOrderLink.deleteMany({ where: { wipManufacturingOrderId: wipMoId } });
    await prisma.stockBalance.deleteMany({ where: { ownership: testOwnership, contractId: testContractId } });

    relationalOrder = await prisma.manufacturingOrder.findUnique({
      where: { moNumber: 'MO-1403-1082' },
      include: { part: true, operations: { include: { operation: true, plannedMachine: true }, orderBy: { stepNumber: 'asc' } } },
    });
    if (!relationalOrder) throw new Error('Seeded MO-1403-1082 is required for the WIP ledger integration test.');
    operation10 = relationalOrder.operations.find((row: any) => row.stepNumber === 10);
    operation20 = relationalOrder.operations.find((row: any) => row.stepNumber === 20);
    if (!operation10 || !operation20 || !operation10.plannedMachineId) {
      throw new Error('Seeded relational operations 10 and 20 with a planned machine are required.');
    }
    part = relationalOrder.part;
    shift = await prisma.shift.findUnique({ where: { code: 'SHIFT-MORN' } });
    user = await prisma.user.findUnique({ where: { username: 'supervisor_press' } });
    if (!shift?.active || !user?.active) throw new Error('Active seeded shift and supervisor user are required.');

    const [sourceRows, targetRows, finalRows, scrapWarehouses] = await Promise.all([
      prisma.warehouseLocation.findMany({ where: { code: 'LOC-WIP-BLANK', active: true }, include: { warehouse: true } }),
      prisma.warehouseLocation.findMany({ where: { code: 'LOC-WIP-DRAWN', active: true }, include: { warehouse: true } }),
      prisma.warehouseLocation.findMany({ where: { code: 'LOC-FIN-P1', active: true }, include: { warehouse: true } }),
      prisma.warehouse.findMany({ where: { type: 'SCRAP', active: true }, include: { locations: { where: { active: true }, orderBy: { code: 'asc' }, take: 1 } } }),
    ]);
    if (sourceRows.length !== 1 || targetRows.length !== 1 || finalRows.length !== 1 || !scrapWarehouses[0]?.locations[0]) {
      throw new Error('Unique active source, intermediate, finished-goods and scrap locations are required by the test fixture.');
    }
    sourceLocation = sourceRows[0];
    targetLocation = targetRows[0];
    const finalLocation = finalRows[0];
    scrapLocation = scrapWarehouses[0].locations[0];

    originalMoValues = { completedQty: relationalOrder.completedQty, scrapQty: relationalOrder.scrapQty };
    originalOperationValues = {
      inputQty: operation10.inputQty,
      outputGoodQty: operation10.outputGoodQty,
      outputScrapQty: operation10.outputScrapQty,
      outputReworkQty: operation10.outputReworkQty,
      outputRejectedQty: operation10.outputRejectedQty,
      status: operation10.status,
      endDate: operation10.endDate,
    };
    originalFinalOperationValues = {
      inputQty: operation20.inputQty,
      outputGoodQty: operation20.outputGoodQty,
      outputScrapQty: operation20.outputScrapQty,
      outputReworkQty: operation20.outputReworkQty,
      outputRejectedQty: operation20.outputRejectedQty,
      status: operation20.status,
      endDate: operation20.endDate,
    };

    const snapshot = await prisma.wipStateSnapshot.findUnique({ where: { id: 'production-wip-state' } });
    hadSnapshot = !!snapshot;
    snapshotCaptured = true;
    originalSnapshot = snapshot?.payload ?? null;
    originalSnapshotVersion = snapshot?.version ?? 1;
    if (!snapshot) {
      await prisma.wipStateSnapshot.create({ data: { id: 'production-wip-state', version: 1, payload: { manufacturingOrders: [], wipTransfers: [], productionLogs: [] } } });
    }

    await prisma.stockBalance.create({
      data: {
        partId: part.id,
        warehouseId: sourceLocation.warehouseId,
        locationId: sourceLocation.id,
        ownership: testOwnership,
        contractId: testContractId,
        contractNumber: testContractId,
        qualityStatus: 'AVAILABLE',
        quantityOnHand: 1000,
        quantityReserved: 0,
        quantityAvailable: 1000,
        weightKgOnHand: 1000 * Number(part.weightNetKg),
        weightKgReserved: 0,
        weightKgAvailable: 1000 * Number(part.weightNetKg),
      },
    });

    await prisma.wipManufacturingOrderLink.create({
      data: {
        wipManufacturingOrderId: wipMoId,
        manufacturingOrderId: relationalOrder.id,
        createdBy: user.id,
        operationLinks: {
          create: [
            { wipOperationId: 'WIP-LEDGER-OP10', productionOperationId: operation10.id },
            { wipOperationId: 'WIP-LEDGER-OP20', productionOperationId: operation20.id },
          ],
        },
      },
    });

    const snapshotPayload = {
      manufacturingOrders: [{
        id: wipMoId,
        moNumber: wipMoId,
        partCode: part.partNumber,
        operations: [
          { id: 'WIP-LEDGER-OP10', stepNumber: 10, sequence: 1, processType: operation10.operation.processType, warehouseLocation: 'LOC-WIP-BLANK', status: 'IN_PROGRESS' },
          { id: 'WIP-LEDGER-OP20', stepNumber: 20, sequence: 2, processType: operation20.operation.processType, warehouseLocation: 'LOC-WIP-DRAWN', status: 'READY' },
        ],
      }],
      wipTransfers: [],
      productionLogs: [],
    };

    const input = {
      wipManufacturingOrderId: wipMoId,
      wipOperationId: 'WIP-LEDGER-OP10',
      idempotencyKey,
      shiftId: shift.id,
      createdByUserId: user.id,
      goodQty: 980,
      scrapQty: 20,
      reworkQty: 0,
      rejectedQty: 0,
      scrapReason: 'TEST_SCRAP',
      operatorName: user.fullName,
      expectedSnapshotVersion: originalSnapshotVersion,
      snapshotPayload,
    };

    const posted = await postWipProductionAtomically(input);
    assert('980 good and 20 scrap posted in one atomic transaction', !posted.duplicate && posted.transactionCount === 3);
    assert('Production report contains 980 good and 20 scrap', Number(posted.report.goodQuantity) === 980 && Number(posted.report.scrapQuantity) === 20);
    assert('Scrap reason is retained in the relational report', posted.report.scrapReasonText === 'TEST_SCRAP');

    const [sourceBalance, targetBalance, scrapBalance, movements] = await Promise.all([
      prisma.stockBalance.findFirst({ where: { partId: part.id, locationId: sourceLocation.id, ownership: testOwnership, contractId: testContractId, qualityStatus: 'AVAILABLE' } }),
      prisma.stockBalance.findFirst({ where: { partId: part.id, locationId: targetLocation.id, ownership: testOwnership, contractId: testContractId, qualityStatus: 'AVAILABLE' } }),
      prisma.stockBalance.findFirst({ where: { partId: part.id, locationId: scrapLocation.id, ownership: testOwnership, contractId: testContractId, qualityStatus: 'SCRAP' } }),
      prisma.inventoryTransaction.findMany({ where: { productionReportId: posted.report.id } }),
    ]);
    assert('Source stage stock is reduced to zero', Number(sourceBalance?.quantityOnHand) === 0);
    assert('980 good pieces are added to the next operation location', Number(targetBalance?.quantityOnHand) === 980);
    assert('20 scrap pieces are added to the scrap location', Number(scrapBalance?.quantityOnHand) === 20);
    assert('Three report-linked ledger movements are written', movements.length === 3);
    assert('Inventory quantity is conserved: 1000 out = 980 good + 20 scrap', movements.reduce((sum: number, row: any) => sum + Number(row.quantitySigned), 0) === 0);

    const replay = await postWipProductionAtomically(input);
    assert('Same idempotency key returns the existing report without new transactions', replay.duplicate && replay.transactionCount === 0);
    const movementCountAfterReplay = await prisma.inventoryTransaction.count({ where: { productionReportId: posted.report.id } });
    assert('Idempotent replay does not duplicate kardex movements', movementCountAfterReplay === 3);

    // Treat operation 20 as the final route stage for this isolated fixture.
    // Its good output must land in finished-goods stock, not another WIP location.
    const finalStageSnapshot = {
      manufacturingOrders: [{
        id: wipMoId,
        moNumber: wipMoId,
        partCode: part.partNumber,
        operations: [{
          id: 'WIP-LEDGER-OP20',
          stepNumber: 20,
          sequence: 1,
          processType: operation20.operation.processType,
          warehouseLocation: 'LOC-WIP-DRAWN',
          status: 'IN_PROGRESS',
        }],
      }],
      wipTransfers: [],
      productionLogs: [],
    };
    const finalStageInput = {
      ...input,
      wipOperationId: 'WIP-LEDGER-OP20',
      idempotencyKey: 'test-wip-ledger-finished-goods-001',
      machineId: operation20.plannedMachineId || operation10.plannedMachineId,
      goodQty: 950,
      scrapQty: 30,
      expectedSnapshotVersion: originalSnapshotVersion + 1,
      snapshotPayload: finalStageSnapshot,
    };
    const finalPosted = await postWipProductionAtomically(finalStageInput);
    assert('Final operation posts 950 good and 30 scrap from the 980-piece intermediate balance',
      !finalPosted.duplicate && Number(finalPosted.report.goodQuantity) === 950 && Number(finalPosted.report.scrapQuantity) === 30);
    const [intermediateAfterFinal, finishedGoods, totalScrap, finalMovements] = await Promise.all([
      prisma.stockBalance.findFirst({ where: { partId: part.id, locationId: targetLocation.id, ownership: testOwnership, contractId: testContractId, qualityStatus: 'AVAILABLE' } }),
      prisma.stockBalance.findFirst({ where: { partId: part.id, locationId: finalLocation.id, ownership: testOwnership, contractId: testContractId, qualityStatus: 'AVAILABLE' } }),
      prisma.stockBalance.findFirst({ where: { partId: part.id, locationId: scrapLocation.id, ownership: testOwnership, contractId: testContractId, qualityStatus: 'SCRAP' } }),
      prisma.inventoryTransaction.findMany({ where: { productionReportId: finalPosted.report.id } }),
    ]);
    assert('Intermediate WIP balance is consumed to zero by final-stage reporting', Number(intermediateAfterFinal?.quantityOnHand) === 0);
    assert('Final-stage good output is posted to LOC-FIN-P1 as finished goods', Number(finishedGoods?.quantityOnHand) === 950);
    assert('Scrap ledger accumulates 50 pieces across both operations', Number(totalScrap?.quantityOnHand) === 50);
    assert('Final production report links its finished-goods and scrap movements', finalMovements.length === 3);

    // Continue the very same production order through customer shipment.
    const [partWithUnit, customer] = await Promise.all([
      prisma.part.findUnique({ where: { id: part.id }, include: { unit: true } }),
      prisma.customer.findFirst({ where: { active: true }, orderBy: { code: 'asc' } }),
    ]);
    if (!partWithUnit?.unit || !customer) {
      throw new Error('An active customer and the final product unit are required for the end-to-end delivery fixture.');
    }
    const deliveryQty = 100;
    const deliveryUnitWeightKg = Number(partWithUnit.weightNetKg || 1);
    const deliveryNow = new Date().toISOString();
    const deliveryDocument: any = {
      id: `DOC-${deliveryDocumentNumber}`,
      documentNumber: deliveryDocumentNumber,
      documentType: 'DELIVERY_CUSTOMER',
      documentDate: deliveryNow,
      documentStatus: 'DRAFT',
      postingStatus: 'UNPOSTED',
      warehouseId: finalLocation.warehouseId,
      warehouseName: finalLocation.warehouse.name,
      ownership: testOwnership,
      referenceType: 'CUSTOMER',
      referenceNumber: customer.code,
      lines: [{
        id: `LINE-${deliveryDocumentNumber}-1`,
        documentId: `DOC-${deliveryDocumentNumber}`,
        lineNumber: 1,
        partId: partWithUnit.id,
        partCode: partWithUnit.partNumber,
        partName: partWithUnit.name,
        ownership: testOwnership,
        contractId: testContractId,
        contractNumber: testContractId,
        locationCode: finalLocation.code,
        quantity: deliveryQty,
        unit: partWithUnit.unit.code,
        quantityKg: Number((deliveryQty * deliveryUnitWeightKg).toFixed(3)),
        qualityStatus: 'AVAILABLE',
      }],
      totalQuantity: deliveryQty,
      totalWeightKg: Number((deliveryQty * deliveryUnitWeightKg).toFixed(3)),
      createdByUid: user.username,
      createdByName: user.fullName,
      createdAt: deliveryNow,
      updatedAt: deliveryNow,
    };
    const deliveryResult = await postDocumentInDbTransaction(deliveryDocument, {
      uid: user.username,
      displayName: user.fullName,
    });
    assert('Customer delivery posts successfully against the finished-goods output of this same WIP order',
      deliveryResult.success && deliveryDocument.postingStatus === 'POSTED');
    const [finishedGoodsAfterDelivery, deliveryLedger, savedDelivery] = await Promise.all([
      prisma.stockBalance.findFirst({
        where: {
          partId: part.id,
          locationId: finalLocation.id,
          ownership: testOwnership,
          contractId: testContractId,
          qualityStatus: 'AVAILABLE',
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
    assert('Customer shipment consumes 100 pieces from the 950 finished goods created by the final WIP operation',
      Number(finishedGoodsAfterDelivery?.quantityOnHand) === 850);
    assert('Customer shipment writes one negative, document-linked PostgreSQL ledger movement',
      deliveryLedger.length === 1 &&
      Number(deliveryLedger[0].quantitySigned) === -deliveryQty &&
      Number(deliveryLedger[0].weightKgSigned) === -Number((deliveryQty * deliveryUnitWeightKg).toFixed(3)));
    assert('Customer delivery persists the customer code and posted status',
      savedDelivery?.postingStatus === 'POSTED' && savedDelivery.referenceNumber === customer.code &&
      savedDelivery.transactions.length === 1);

    let rollbackRejected = false;
    try {
      await postWipProductionAtomically({
        ...finalStageInput,
        idempotencyKey: rollbackKey,
        expectedSnapshotVersion: originalSnapshotVersion + 2,
        goodQty: 1,
        scrapQty: 0,
      });
    } catch (error) {
      rollbackRejected = error instanceof Error && error.message.includes('Insufficient source WIP stock');
    }
    assert('Insufficient source stock rejects final-stage posting', rollbackRejected);
    assert('Failed posting leaves no relational production report', !(await prisma.productionReport.findUnique({ where: { wipIdempotencyKey: rollbackKey } })));
    assert('Failed posting leaves no extra first-stage inventory transactions', await prisma.inventoryTransaction.count({ where: { productionReportId: posted.report.id } }) === 3);

    console.log('ALL ATOMIC WIP PRODUCTION AND FINISHED-GOODS LEDGER TESTS PASSED');
  } finally {
    const reports = await prisma.productionReport.findMany({
      where: { wipIdempotencyKey: { in: [idempotencyKey, rollbackKey] } },
      select: { id: true },
    });
    if (reports.length) {
      await prisma.inventoryTransaction.deleteMany({ where: { productionReportId: { in: reports.map((row: any) => row.id) } } });
      await prisma.productionReport.deleteMany({ where: { id: { in: reports.map((row: any) => row.id) } } });
    }
    await prisma.wipManufacturingOrderLink.deleteMany({ where: { wipManufacturingOrderId: wipMoId } });
    await prisma.stockBalance.deleteMany({ where: { ownership: testOwnership, contractId: testContractId } });
    if (relationalOrder && originalMoValues) {
      await prisma.manufacturingOrder.update({
        where: { id: relationalOrder.id },
        data: { completedQty: originalMoValues.completedQty, scrapQty: originalMoValues.scrapQty },
      });
    }
    if (operation10 && originalOperationValues) {
      await prisma.productionOperation.update({
        where: { id: operation10.id },
        data: originalOperationValues,
      });
    }
    if (operation20 && originalFinalOperationValues) {
      await prisma.productionOperation.update({
        where: { id: operation20.id },
        data: originalFinalOperationValues,
      });
    }
    if (snapshotCaptured && hadSnapshot) {
      await prisma.wipStateSnapshot.upsert({
        where: { id: 'production-wip-state' },
        create: { id: 'production-wip-state', payload: originalSnapshot, version: originalSnapshotVersion },
        update: { payload: originalSnapshot, version: originalSnapshotVersion },
      });
    } else if (snapshotCaptured) {
      await prisma.wipStateSnapshot.deleteMany({ where: { id: 'production-wip-state' } });
    }
    await prisma.$disconnect();
  }
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
