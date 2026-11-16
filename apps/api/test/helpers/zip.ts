import { createDeflateRaw } from 'node:zlib';

/** Comprime `size` bytes de zeros sem alocar o conteúdo inteiro. */
export async function deflatedZeros(size: number): Promise<Buffer> {
  const deflate = createDeflateRaw({ level: 9 });
  const chunks: Buffer[] = [];
  deflate.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    deflate.on('end', resolve);
    deflate.on('error', reject);
  });
  const block = Buffer.alloc(1024 * 1024);
  for (let remaining = size; remaining > 0; remaining -= block.length) {
    const piece = remaining >= block.length ? block : block.subarray(0, remaining);
    if (!deflate.write(piece)) await new Promise((resolve) => deflate.once('drain', resolve));
  }
  deflate.end();
  await done;
  return Buffer.concat(chunks);
}

/** Acrescenta a um zip existente uma entrada já comprimida (deflate cru) com o tamanho descompactado dado. */
export function appendZipEntry(zip: Buffer, name: string, deflated: Buffer, size: number): Buffer {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  const directorySize = zip.readUInt32LE(end + 12);
  const directoryOffset = zip.readUInt32LE(end + 16);
  const fileName = Buffer.from(name, 'utf8');

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(size, 22);
  local.writeUInt16LE(fileName.length, 26);

  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(8, 10);
  header.writeUInt32LE(deflated.length, 20);
  header.writeUInt32LE(size, 24);
  header.writeUInt16LE(fileName.length, 28);
  header.writeUInt32LE(directoryOffset, 42);

  const newEntry = Buffer.concat([local, fileName, deflated]);
  const directory = Buffer.concat([zip.subarray(directoryOffset, directoryOffset + directorySize), header, fileName]);
  const record = Buffer.alloc(22);
  record.writeUInt32LE(0x06054b50, 0);
  record.writeUInt16LE(count + 1, 8);
  record.writeUInt16LE(count + 1, 10);
  record.writeUInt32LE(directory.length, 12);
  record.writeUInt32LE(directoryOffset + newEntry.length, 16);
  return Buffer.concat([zip.subarray(0, directoryOffset), newEntry, directory, record]);
}
