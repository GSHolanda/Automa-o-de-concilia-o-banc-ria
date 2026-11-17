import ExcelJS from 'exceljs';
import { neutralizeFormula } from './csv';
import { formatGeneratedAt } from './format';
import type { Cell, Column, Report } from './model';

const MONEY_FORMAT = '#,##0.00;-#,##0.00';
const DATE_FORMAT = 'dd/mm/yyyy';

/** Data civil como instante UTC à meia-noite, para a planilha não deslocar o dia. */
function civilDate(iso: string): Date {
  return new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
}

function cellValue(column: Column, value: Cell): ExcelJS.CellValue {
  if (value === null || value === '') return null;
  if (column.kind === 'money' && typeof value === 'number') return value / 100;
  if (column.kind === 'int' && typeof value === 'number') return value;
  if (column.kind === 'date' && typeof value === 'string') return civilDate(value);
  return neutralizeFormula(String(value));
}

/** Uma aba por seção. Datas e números são células tipadas; texto passa pela neutralização de fórmulas. */
export async function renderXlsx(report: Report): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = report.company || 'Concilia';
  workbook.created = report.generatedAt;
  workbook.modified = report.generatedAt;

  for (const section of report.sections) {
    const sheet = workbook.addWorksheet(section.title.slice(0, 31));
    sheet.getCell(1, 1).value = neutralizeFormula(report.title);
    sheet.getCell(1, 1).font = { bold: true, size: 14 };
    const intro = [
      report.company,
      ...report.subtitle,
      `Gerado em ${formatGeneratedAt(report.generatedAt)} por ${report.generatedBy}`,
    ];
    intro.forEach((line, index) => {
      sheet.getCell(2 + index, 1).value = neutralizeFormula(line);
    });

    const headerRow = 2 + intro.length + 1;
    const header = sheet.getRow(headerRow);
    section.columns.forEach((column, index) => {
      const cell = header.getCell(index + 1);
      cell.value = column.label;
      cell.font = { bold: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8ECF1' } };
      sheet.getColumn(index + 1).width = Math.max(column.width, column.label.length + 2);
    });
    section.rows.forEach((row, rowIndex) => {
      const target = sheet.getRow(headerRow + 1 + rowIndex);
      row.forEach((value, index) => {
        const column = section.columns[index]!;
        const cell = target.getCell(index + 1);
        cell.value = cellValue(column, value);
        if (column.kind === 'money') cell.numFmt = MONEY_FORMAT;
        else if (column.kind === 'date') cell.numFmt = DATE_FORMAT;
        else if (column.kind === 'int') cell.numFmt = '0';
      });
    });
    sheet.views = [{ state: 'frozen', ySplit: headerRow }];
    if (section.rows.length > 0) {
      sheet.autoFilter = {
        from: { row: headerRow, column: 1 },
        to: { row: headerRow + section.rows.length, column: section.columns.length },
      };
    }

    let next = headerRow + section.rows.length + 2;
    for (const total of section.totals) {
      sheet.getCell(next, 1).value = total.label;
      sheet.getCell(next, 1).font = { bold: true };
      const cell = sheet.getCell(next, 2);
      cell.value = total.kind === 'money' ? total.value / 100 : total.value;
      cell.numFmt = total.kind === 'money' ? MONEY_FORMAT : '0';
      cell.font = { bold: true };
      next += 1;
    }
    if (report.footer) sheet.getCell(next + 1, 1).value = neutralizeFormula(report.footer);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
