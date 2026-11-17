import { crc32, inflateRaw } from 'node:zlib';

/**
 * Leitura defensiva de arquivos zip (base do XLSX). Os limites valem antes de descompactar
 * (pelo diretório central) e durante (a saída do inflate nunca passa do tamanho declarado).
 */
export interface ZipLimits {
  /** Número máximo de entradas no arquivo. */
  maxEntries: number;
  /** Tamanho descompactado máximo de uma entrada, em bytes. */
  maxEntryBytes: number;
  /** Soma máxima dos tamanhos descompactados de todas as entradas, em bytes. */
  maxTotalBytes: number;
  /** Razão máxima entre tamanho descompactado e comprimido, para entradas acima de 1 MiB. */
  maxCompressionRatio: number;
}

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  /** Posição dos dados comprimidos no arquivo. */
  dataStart: number;
}

const MiB = 1024 * 1024;
const RATIO_MIN_BYTES = MiB;
const INVALID = 'O arquivo não é uma planilha XLSX válida';

/** Erro de limite: o arquivo é recusado com mensagem para o usuário. */
export class SpreadsheetLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpreadsheetLimitError';
  }
}

function mib(bytes: number): string {
  return `${Math.round(bytes / MiB)} MB`;
}

/** Lê o diretório central e confere os limites, sem descompactar nada. */
export function listZipEntries(bytes: Uint8Array, limits: ZipLimits): Map<string, ZipEntry> {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Registro de fim do diretório central: 22 bytes mais comentário de até 65535.
  let end = -1;
  for (let index = view.length - 22; index >= Math.max(0, view.length - 22 - 65_535); index -= 1) {
    if (view.readUInt32LE(index) === 0x06054b50) {
      end = index;
      break;
    }
  }
  if (end < 0) throw new Error(INVALID);
  const count = view.readUInt16LE(end + 10);
  const directorySize = view.readUInt32LE(end + 12);
  const directoryOffset = view.readUInt32LE(end + 16);
  if (count === 0xffff || directoryOffset === 0xffffffff || directorySize === 0xffffffff) {
    throw new SpreadsheetLimitError('Planilhas em formato ZIP64 não são aceitas.');
  }
  if (count > limits.maxEntries) {
    throw new SpreadsheetLimitError(`A planilha tem ${count} entradas internas; o limite é ${limits.maxEntries}.`);
  }
  if (directoryOffset + directorySize > end) throw new Error(INVALID);

  const entries = new Map<string, ZipEntry>();
  let total = 0;
  let position = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (position + 46 > end || view.readUInt32LE(position) !== 0x02014b50) throw new Error(INVALID);
    const flags = view.readUInt16LE(position + 8);
    const method = view.readUInt16LE(position + 10);
    const compressedSize = view.readUInt32LE(position + 20);
    const size = view.readUInt32LE(position + 24);
    const nameLength = view.readUInt16LE(position + 28);
    const extraLength = view.readUInt16LE(position + 30);
    const commentLength = view.readUInt16LE(position + 32);
    const localOffset = view.readUInt32LE(position + 42);
    const name = view.toString('utf8', position + 46, position + 46 + nameLength);
    position += 46 + nameLength + extraLength + commentLength;

    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new SpreadsheetLimitError('Planilhas em formato ZIP64 não são aceitas.');
    }
    if (flags & 0x1) throw new SpreadsheetLimitError('Planilhas protegidas por senha não são aceitas.');
    if (method !== 0 && method !== 8) throw new Error(INVALID);
    if (entries.has(name)) throw new Error(INVALID);
    if (size > limits.maxEntryBytes) {
      throw new SpreadsheetLimitError(
        `A planilha tem uma parte interna de ${mib(size)} descompactada; o limite é ${mib(limits.maxEntryBytes)}.`,
      );
    }
    total += size;
    if (total > limits.maxTotalBytes) {
      throw new SpreadsheetLimitError(`A planilha descompactada passa de ${mib(limits.maxTotalBytes)}, o limite aceito.`);
    }
    if (size > RATIO_MIN_BYTES && size / Math.max(compressedSize, 1) > limits.maxCompressionRatio) {
      throw new SpreadsheetLimitError('A planilha tem uma parte interna com compressão fora do normal e foi recusada.');
    }

    if (localOffset + 30 > view.length || view.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(INVALID);
    const dataStart = localOffset + 30 + view.readUInt16LE(localOffset + 26) + view.readUInt16LE(localOffset + 28);
    if (dataStart + compressedSize > view.length) throw new Error(INVALID);
    if (method === 0 && compressedSize !== size) throw new Error(INVALID);
    entries.set(name, { name, method, compressedSize, size, dataStart });
  }
  return entries;
}

/**
 * Descompacta uma entrada. A saída é limitada ao tamanho declarado no diretório central (já conferido
 * contra os limites); se o conteúdo real for maior, a leitura é interrompida e o arquivo recusado.
 */
export async function inflateEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Buffer> {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const data = view.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(data);
  const output = await new Promise<Buffer>((resolve, reject) => {
    inflateRaw(data, { maxOutputLength: Math.max(entry.size, 1) }, (error, result) => {
      if (!error) resolve(result);
      else if ((error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
        reject(new SpreadsheetLimitError('O tamanho descompactado de uma parte da planilha não confere com o declarado.'));
      } else reject(new Error(INVALID, { cause: error }));
    });
  });
  if (output.length !== entry.size) {
    throw new SpreadsheetLimitError('O tamanho descompactado de uma parte da planilha não confere com o declarado.');
  }
  return output;
}

/** Monta um zip sem compressão, em pedaços de até `chunkSize` bytes, para leitura em fluxo. */
export function storedZip(files: ReadonlyArray<{ name: string; data: Buffer }>, chunkSize = 16 * 1024): Buffer[] {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const crc = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(10, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name);
    for (let start = 0; start < file.data.length; start += chunkSize) {
      chunks.push(file.data.subarray(start, start + chunkSize));
    }
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(10, 4);
    header.writeUInt16LE(10, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(file.data.length, 20);
    header.writeUInt32LE(file.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += 30 + name.length + file.data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  chunks.push(directory, end);
  return chunks;
}
