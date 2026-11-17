import { crc32, createDeflateRaw, deflateRawSync } from 'node:zlib';

/** Entrada de um zip montado no teste. */
export interface TestZipEntry {
  name: string;
  /** Conteúdo descompactado; comprimido com deflate. */
  data?: Buffer;
  /** Conteúdo já comprimido (deflate cru), com o tamanho descompactado real em `size`. */
  deflated?: { bytes: Buffer; size: number };
  /** Tamanho descompactado declarado, quando o teste quer mentir sobre ele. */
  declaredSize?: number;
}

/** Monta um zip mínimo (diretório central e cabeçalhos locais coerentes). */
export function buildZip(entries: TestZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = entry.deflated ? entry.deflated.bytes : deflateRawSync(entry.data ?? Buffer.alloc(0));
    const realSize = entry.deflated ? entry.deflated.size : (entry.data ?? Buffer.alloc(0)).length;
    const size = entry.declaredSize ?? realSize;
    const crc = entry.data ? crc32(entry.data) : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(size, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** Comprime `size` bytes de zeros sem alocar o conteúdo inteiro. */
export async function deflatedZeros(size: number): Promise<{ bytes: Buffer; size: number }> {
  const deflate = createDeflateRaw({ level: 9 });
  const chunks: Buffer[] = [];
  deflate.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    deflate.on('end', resolve);
    deflate.on('error', reject);
  });
  const block = Buffer.alloc(1024 * 1024);
  let remaining = size;
  while (remaining > 0) {
    const piece = remaining >= block.length ? block : block.subarray(0, remaining);
    remaining -= piece.length;
    if (!deflate.write(piece)) await new Promise((resolve) => deflate.once('drain', resolve));
  }
  deflate.end();
  await done;
  return { bytes: Buffer.concat(chunks), size };
}

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DOC = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** Partes de uma planilha XLSX mínima com uma aba, a partir do XML de `sheetData`. */
export function xlsxParts(sheetData: string, sheetEntry: Partial<TestZipEntry> = {}): TestZipEntry[] {
  const text = (value: string) => Buffer.from(value, 'utf8');
  return [
    {
      name: '[Content_Types].xml',
      data: text(
        `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
          `<Default Extension="xml" ContentType="application/xml"/>` +
          `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
          `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
          `</Types>`,
      ),
    },
    {
      name: '_rels/.rels',
      data: text(
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${RELS}">` +
          `<Relationship Id="rId1" Type="${DOC}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      ),
    },
    {
      name: 'xl/workbook.xml',
      data: text(
        `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${MAIN}" xmlns:r="${DOC}">` +
          `<sheets><sheet name="Plan1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: text(
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${RELS}">` +
          `<Relationship Id="rId1" Type="${DOC}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      ),
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: text(`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${MAIN}"><sheetData>${sheetData}</sheetData></worksheet>`),
      ...sheetEntry,
    },
  ];
}

/** Linhas numéricas simples para `sheetData`. */
export function numericRows(count: number, columns = 1): string {
  const letters = (index: number) => {
    let result = '';
    for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + ((n - 1) % 26)) + result;
    return result;
  };
  let xml = '';
  for (let row = 1; row <= count; row += 1) {
    xml += `<row r="${row}">`;
    for (let column = 1; column <= columns; column += 1) xml += `<c r="${letters(column)}${row}"><v>${row}</v></c>`;
    xml += '</row>';
  }
  return xml;
}
