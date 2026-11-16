import { formatBRL, formatDateBR } from '@concilia/core';
import PDFDocument from 'pdfkit';
import { formatGeneratedAt } from './format';
import type { Cell, Column, Report, Section } from './model';

const MARGIN = 36;
const FONT = 'Helvetica';
const FONT_BOLD = 'Helvetica-Bold';
const FOOTER_SPACE = 22;

/** Fonte padrão do PDF só cobre Latin-1: troca controles e o que ficar de fora por "?". */
function printable(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[^ -ÿ]/g, '?');
}

function cellText(column: Column, value: Cell): string {
  if (value === null || value === '') return '';
  if (column.kind === 'money' && typeof value === 'number') return formatBRL(value);
  if (column.kind === 'date' && typeof value === 'string') return formatDateBR(value);
  return printable(String(value));
}

export interface PdfOptions {
  /** Comprime os fluxos. Desligado em testes para que o texto possa ser extraído e conferido. */
  compress: boolean;
}

/** PDF A4 paisagem: cabeçalho (empresa, título, período, gerado em/por), tabela, totais e "Página x de y". */
export function renderPdf(report: Report, options: PdfOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margin: MARGIN,
      bufferPages: true,
      compress: options.compress,
      info: { Title: printable(report.title), Author: printable(report.company), Creator: 'Concilia', CreationDate: report.generatedAt },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const width = doc.page.width - MARGIN * 2;
    const bottom = () => doc.page.height - MARGIN - FOOTER_SPACE;

    const drawHeader = (): void => {
      doc.font(FONT_BOLD).fontSize(9).fillColor('#555555').text(printable(report.company), MARGIN, MARGIN, { width });
      doc.font(FONT_BOLD).fontSize(16).fillColor('#111111').text(printable(report.title), { width });
      doc.font(FONT).fontSize(9).fillColor('#333333');
      for (const line of report.subtitle) doc.text(printable(line), { width });
      doc.text(`Gerado em ${formatGeneratedAt(report.generatedAt)} por ${printable(report.generatedBy)}`, { width });
      doc.moveDown(0.6);
    };

    const layout = (columns: Column[]): { x: number; w: number }[] => {
      const total = columns.reduce((acc, column) => acc + column.width, 0);
      let x = MARGIN;
      return columns.map((column) => {
        const w = (column.width / total) * width;
        const slot = { x, w };
        x += w;
        return slot;
      });
    };

    const drawRow = (columns: Column[], slots: { x: number; w: number }[], texts: string[], bold: boolean, y: number): number => {
      doc.font(bold ? FONT_BOLD : FONT).fontSize(8);
      const height = Math.max(
        ...texts.map((text, index) => doc.heightOfString(text, { width: slots[index]!.w - 6 })),
        10,
      );
      texts.forEach((text, index) => {
        const column = columns[index]!;
        const right = column.kind === 'money' || column.kind === 'int';
        doc.fillColor('#111111').text(text, slots[index]!.x + 3, y, { width: slots[index]!.w - 6, align: right ? 'right' : 'left' });
      });
      return height + 4;
    };

    const drawSection = (section: Section, first: boolean): void => {
      const slots = layout(section.columns);
      if (!first) {
        doc.addPage();
        drawHeader();
      }
      doc.font(FONT_BOLD).fontSize(11).fillColor('#111111').text(printable(section.title), MARGIN, doc.y, { width });
      doc.moveDown(0.3);

      const header = (): void => {
        const y = doc.y;
        doc.rect(MARGIN, y - 2, width, 14).fill('#e8ecf1');
        const used = drawRow(section.columns, slots, section.columns.map((column) => column.label), true, y);
        doc.y = y + used;
      };
      header();
      for (const row of section.rows) {
        const texts = row.map((value, index) => cellText(section.columns[index]!, value));
        doc.font(FONT).fontSize(8);
        const needed = Math.max(...texts.map((text, index) => doc.heightOfString(text, { width: slots[index]!.w - 6 })), 10) + 4;
        if (doc.y + needed > bottom()) {
          doc.addPage();
          drawHeader();
          header();
        }
        const y = doc.y;
        doc.y = y + drawRow(section.columns, slots, texts, false, y);
      }
      if (section.rows.length === 0) {
        doc.font(FONT).fontSize(9).fillColor('#555555').text('Nenhum item.', MARGIN + 3, doc.y, { width });
      }
      if (section.totals.length > 0) {
        if (doc.y + 14 * section.totals.length + 12 > bottom()) {
          doc.addPage();
          drawHeader();
        }
        doc.moveDown(0.6);
        for (const total of section.totals) {
          const value = total.kind === 'money' ? formatBRL(total.value) : String(total.value);
          doc.font(FONT_BOLD).fontSize(9).fillColor('#111111').text(`${total.label}: ${value}`, MARGIN, doc.y, { width });
        }
      }
      if (report.footer) {
        doc.moveDown(0.8);
        doc.font(FONT).fontSize(8).fillColor('#555555').text(printable(report.footer), MARGIN, doc.y, { width });
      }
    };

    drawHeader();
    report.sections.forEach((section, index) => drawSection(section, index === 0));

    // Numeração de páginas: escrita no fim, com a margem inferior zerada para não abrir página nova.
    const range = doc.bufferedPageRange();
    for (let index = 0; index < range.count; index += 1) {
      doc.switchToPage(range.start + index);
      doc.page.margins.bottom = 0;
      doc.font(FONT).fontSize(8).fillColor('#555555');
      doc.text(`Página ${index + 1} de ${range.count}`, MARGIN, doc.page.height - MARGIN, { width, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}
