import type { PrismaClient } from '@prisma/client';

type ImportRow = Record<string, unknown>;

const textValue = (row: ImportRow, keys: string[], fallback = ''): string => {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  return fallback;
};

const numberValue = (row: ImportRow, keys: string[]): number | undefined => {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
};

const normalizeUnitCode = (value: string): string => {
  const normalized = value.trim().toUpperCase();
  const aliases: Record<string, string> = {
    'KGS': 'KG', 'کیلوگرم': 'KG', 'کیلو': 'KG',
    'PC': 'PCS', 'PIECE': 'PCS', 'عدد': 'PCS',
    'COIL': 'ROLL', 'کلاف': 'ROLL', 'رول': 'ROLL',
    'SHEET': 'SHEET', 'برگ': 'SHEET',
  };
  return aliases[normalized] || normalized.replace(/[^A-Z0-9_-]/g, '_');
};

const normalizeCategory = (value: string): 'RAW_MATERIAL' | 'WIP_PART' | 'FINISHED_GOOD' | 'CONSUMABLE' => {
  const normalized = value.trim().toUpperCase();
  if (['WIP', 'WIP_PART', 'SEMI_FINISHED', 'نیمه ساخته', 'کالای نیمه ساخته'].includes(normalized)) return 'WIP_PART';
  if (['FINISHED_GOOD', 'FINISHED', 'محصول نهایی'].includes(normalized)) return 'FINISHED_GOOD';
  if (['CONSUMABLE', 'مواد مصرفی'].includes(normalized)) return 'CONSUMABLE';
  if (['RAW_MATERIAL', 'RAW', 'MATERIAL', 'مواد اولیه', 'ورق', 'پیچ و مهره', 'لاستیک'].includes(normalized)) return 'RAW_MATERIAL';
  throw new Error(`دسته کالای «${value}» در ساختار اطلاعات پایه پشتیبانی نمی‌شود. دسته را به RAW_MATERIAL، WIP_PART، FINISHED_GOOD یا CONSUMABLE نگاشت کنید.`);
};

/**
 * Persists imported item master rows in the normalized PostgreSQL catalog.
 * The database transaction commits before the caller updates its in-memory read model.
 */
export async function syncImportedPartMasterRows(
  prisma: PrismaClient,
  rows: ImportRow[],
): Promise<Array<{
  id: string;
  partNumber: string;
  name: string;
  category: string;
  unit: { code: string };
  material: { grade: string } | null;
  thicknessMm: unknown;
  weightNetKg: unknown;
  supplierPartNumber: string | null;
}>> {
  return prisma.$transaction(async (tx) => {
    const persisted = [];
    for (const row of rows) {
      const partNumber = textValue(row, ['code', 'partCode', 'کد قطعه', 'کد کالا']);
      const name = textValue(row, ['name', 'partName', 'نام قطعه', 'نام کالا', 'شرح قطعه'], partNumber);
      if (!partNumber || !name) continue;

      const unitCode = normalizeUnitCode(textValue(row, ['unit', 'واحد', 'واحد سنجش'], 'KG'));
      const unitName = textValue(row, ['unitName', 'نام واحد'], unitCode);
      const unit = await tx.unitOfMeasure.upsert({
        where: { code: unitCode },
        create: { code: unitCode, name: unitName, symbol: unitCode.toLowerCase(), isBase: ['KG', 'PCS'].includes(unitCode) },
        update: { name: unitName, active: true },
      });

      const grade = textValue(row, ['materialGrade', 'grade', 'گرید متریال', 'گرید'], '');
      let materialId: string | undefined;
      if (grade) {
        const materialCode = `MAT-${grade.toUpperCase().replace(/[^A-Z0-9]+/g, '-')}`;
        const material = await tx.material.upsert({
          where: { code: materialCode },
          create: { code: materialCode, name: textValue(row, ['materialName', 'نام متریال'], `ورق فولادی ${grade}`), grade },
          update: { grade, active: true },
        });
        materialId = material.id;
      }

      const rawCategory = textValue(row, ['category', 'دسته کالا', 'گروه کالا', 'گروه'], 'RAW_MATERIAL');
      const category = normalizeCategory(rawCategory);
      const thicknessMm = numberValue(row, ['thicknessMm', 'ضخامت', 'ضخامت (mm)']);
      const weight = numberValue(row, ['weightPerUnitKg', 'weightNetKg', 'وزن واحد (kg)', 'وزن خالص (kg)']) ?? 0;
      const supplierPartNumber = textValue(row, ['supplierPartNumber', 'sapcoCode', 'کد ساپکو'], '') || null;

      const part = await tx.part.upsert({
        where: { partNumber },
        create: {
          partNumber, name, category, unitId: unit.id, materialId,
          thicknessMm, weightNetKg: weight, supplierPartNumber, active: true,
        },
        update: {
          name, category, unitId: unit.id, materialId,
          thicknessMm, weightNetKg: weight, supplierPartNumber, active: true,
        },
        include: { unit: { select: { code: true } }, material: { select: { grade: true } } },
      });
      persisted.push(part);
    }
    return persisted;
  });
}
