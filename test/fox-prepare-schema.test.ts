import { describe, expect, it } from 'vitest';
import { convertFoxPro } from '../src/converter';
import { tableFor } from '../src/shared/fox-prepare';
import type { SchemaTable } from '../src/shared/types';

const col = (name: string) => ({ name, dataType: 'money', maxLength: null, nullable: true });
const tables: SchemaTable[] = [
  { schema: 'xbase', name: 'vw_PayIncome', isView: true, columns: [col('BasicSalary'), col('NetSalVND')] },
  { schema: 'dbo', name: 'HCSPR_PayIncome', isView: false, columns: [col('GrossSalVND')] },
];

describe('work-area table outside dbo', () => {
  it('names the schema so USE finds the view', () => {
    expect(tableFor('SUM BasicSalary - NetSalVND', tables).table).toBe('xbase.vw_PayIncome');
    expect(tableFor('SUM GrossSalVND', tables).table).toBe('HCSPR_PayIncome');
  });
  it('USE with a schema becomes the table of the SUM', () => {
    const out = convertFoxPro('USE xbase.vw_PayIncome\nSUM BasicSalary - NetSalVND');
    expect(out.errors).toEqual([]);
    expect(out.sql).toMatch(/FROM xbase\.vw_payincome/i);
  });
});
