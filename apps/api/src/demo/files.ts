import ExcelJS from 'exceljs';

// Dados FICTÍCIOS de demonstração. Empresa, banco, contas, clientes, fornecedores e valores são inventados.

export interface DemoFile {
  name: string;
  kind: 'bank' | 'ledger';
  account: 'movimento' | 'reserva' | null;
  content: Buffer;
}

/** Transação do extrato: valores em centavos, data civil AAAA-MM-DD. */
interface Tx {
  fitId: string;
  date: string;
  cents: number;
  memo: string;
}

/** Lançamento do sistema de origem (planilha). */
interface Lancamento {
  paymentDate: string;
  favorecido: string;
  descricao: string;
  documento: string | null;
  cents: number;
  conta: 'MOVIMENTO' | 'RESERVA';
}

const ACCOUNT_ID = '12345-6';
const BANK_ID = '0999';

// Extrato MOVIMENTO de janeiro (37 transações). FITID sequencial e único.
const MOVIMENTO_JAN: Tx[] = [
  // a) recebimentos com NF 4501 a 4512
  { fitId: 'MOV202401001', date: '2024-01-03', cents: 18000, memo: 'PIX RECEBIDO ALFA DISTRIBUIDORA NF 4501' },
  { fitId: 'MOV202401002', date: '2024-01-04', cents: 32550, memo: 'PIX RECEBIDO BETA MATERIAIS NF 4502' },
  { fitId: 'MOV202401003', date: '2024-01-05', cents: 61075, memo: 'PIX RECEBIDO GAMA SERVICOS NF 4503' },
  { fitId: 'MOV202401004', date: '2024-01-08', cents: 94210, memo: 'PIX RECEBIDO DELTA ATACADO NF 4504' },
  { fitId: 'MOV202401005', date: '2024-01-09', cents: 118000, memo: 'PIX RECEBIDO ORION COMERCIO NF 4505' },
  { fitId: 'MOV202401006', date: '2024-01-11', cents: 149990, memo: 'PIX RECEBIDO VEGA ELETRO NF 4506' },
  { fitId: 'MOV202401007', date: '2024-01-12', cents: 205000, memo: 'PIX RECEBIDO ATLAS CONSTRUCOES NF 4507' },
  { fitId: 'MOV202401008', date: '2024-01-16', cents: 238745, memo: 'PIX RECEBIDO NOVA ALIANCA NF 4508' },
  { fitId: 'MOV202401009', date: '2024-01-17', cents: 312000, memo: 'PIX RECEBIDO PRIMA TEXTIL NF 4509' },
  { fitId: 'MOV202401010', date: '2024-01-22', cents: 367530, memo: 'PIX RECEBIDO ZENITH FARMA NF 4510' },
  { fitId: 'MOV202401011', date: '2024-01-23', cents: 421000, memo: 'PIX RECEBIDO CASA DO SUL NF 4511' },
  { fitId: 'MOV202401012', date: '2024-01-26', cents: 490000, memo: 'PIX RECEBIDO RIO BRANCO LTDA NF 4512' },
  // b) pagamentos a fornecedores
  { fitId: 'MOV202401013', date: '2024-01-04', cents: -85000, memo: 'PAGTO FORNECEDOR PAPEL NORTE DOC 880101' },
  { fitId: 'MOV202401014', date: '2024-01-05', cents: -127540, memo: 'PAGTO FORNECEDOR METALURGICA SUL DOC 880102' },
  { fitId: 'MOV202401015', date: '2024-01-09', cents: -42000, memo: 'PAGTO FORNECEDOR TRANSPORTES RAPIDO DOC 880103' },
  { fitId: 'MOV202401016', date: '2024-01-12', cents: -301000, memo: 'PAGTO FORNECEDOR EMBALAGENS MINAS DOC 880104' },
  { fitId: 'MOV202401017', date: '2024-01-16', cents: -56025, memo: 'PAGTO FORNECEDOR LIMPEZA TOTAL DOC 880105' },
  { fitId: 'MOV202401018', date: '2024-01-19', cents: -214000, memo: 'PAGTO FORNECEDOR INFORMATICA PRIME DOC 880106' },
  { fitId: 'MOV202401019', date: '2024-01-26', cents: -79090, memo: 'PAGTO FORNECEDOR CARTONAGEM NORTE DOC 880107' },
  { fitId: 'MOV202401020', date: '2024-01-29', cents: -100515, memo: 'PAGTO FORNECEDOR GRAFICA VIDA DOC 880108' },
  // c) recebimentos sem número de documento, valores únicos no mês
  { fitId: 'MOV202401021', date: '2024-01-07', cents: 26540, memo: 'PIX RECEBIDO LOJA BAIRRO NORTE' },
  { fitId: 'MOV202401022', date: '2024-01-13', cents: 51280, memo: 'PIX RECEBIDO LOJA SHOPPING' },
  { fitId: 'MOV202401023', date: '2024-01-19', cents: 173860, memo: 'PIX RECEBIDO LOJA AEROPORTO' },
  { fitId: 'MOV202401024', date: '2024-01-25', cents: 290315, memo: 'PIX RECEBIDO LOJA SÃO JOSÉ' },
  { fitId: 'MOV202401025', date: '2024-01-30', cents: 331790, memo: 'PIX RECEBIDO LOJA INDUSTRIAL' },
  // d) dois recebimentos avulsos iguais no mesmo dia
  { fitId: 'MOV202401026', date: '2024-01-15', cents: 75000, memo: 'PIX RECEBIDO CLIENTE AVULSO' },
  { fitId: 'MOV202401027', date: '2024-01-15', cents: 75000, memo: 'PIX RECEBIDO CLIENTE AVULSO' },
  // e) recebimento com NF 4520
  { fitId: 'MOV202401028', date: '2024-01-12', cents: 199450, memo: 'PIX RECEBIDO MERCADO SOL NASCENTE NF 4520' },
  // f) depósito de lote de cartões
  { fitId: 'MOV202401029', date: '2024-01-18', cents: 360000, memo: 'DEP LOTE CARTOES' },
  // g) tarifas
  { fitId: 'MOV202401030', date: '2024-01-31', cents: -8990, memo: 'TARIFA PACOTE SERVICOS' },
  { fitId: 'MOV202401031', date: '2024-01-31', cents: -1200, memo: 'TAR PIX' },
  { fitId: 'MOV202401032', date: '2024-01-31', cents: -347, memo: 'IOF' },
  // h) boleto de energia e estorno
  { fitId: 'MOV202401033', date: '2024-01-10', cents: -64000, memo: 'PAGTO BOLETO ENERGIA' },
  { fitId: 'MOV202401034', date: '2024-01-14', cents: 64000, memo: 'ESTORNO PAGTO BOLETO ENERGIA' },
  // i) transferência entre contas
  { fitId: 'MOV202401035', date: '2024-01-20', cents: -1000000, memo: 'TRANSF ENTRE CONTAS MESMA TITULARIDADE' },
  // j) lançamentos sem correspondência
  { fitId: 'MOV202401036', date: '2024-01-21', cents: 33333, memo: 'PIX RECEBIDO NAO IDENTIFICADO' },
  { fitId: 'MOV202401037', date: '2024-01-28', cents: -21000, memo: 'DEBITO AUTOMATICO SEGURO' },
];

// Três transações novas, presentes só no complemento.
const MOVIMENTO_COMPLEMENTO_NOVAS: Tx[] = [
  { fitId: 'MOV202401101', date: '2024-01-27', cents: 71825, memo: 'PIX RECEBIDO LOJA CENTRO' },
  { fitId: 'MOV202401102', date: '2024-01-29', cents: -98000, memo: 'PAGTO FORNECEDOR CARTONAGEM NORTE DOC 880109' },
  { fitId: 'MOV202401103', date: '2024-01-31', cents: -4990, memo: 'TAR CESTA RELACIONAMENTO' },
];

// Movimentos da conta RESERVA (abertura de R$ 25.000,00).
const RESERVA_ABERTURA_CENTS = 2500000;
const RESERVA_MOVIMENTOS: Array<{ date: string; memo: string; documento: string; cents: number }> = [
  { date: '2024-01-05', memo: 'RENDIMENTO APLICACAO', documento: '', cents: 8412 },
  { date: '2024-01-12', memo: 'IMPOSTO RENDIMENTO', documento: '', cents: -1682 },
  { date: '2024-01-20', memo: 'TRANSF ENTRE CONTAS MESMA TITULARIDADE', documento: 'TRF0120', cents: 1000000 },
  { date: '2024-01-25', memo: 'RENDIMENTO APLICACAO', documento: '', cents: 9140 },
  { date: '2024-01-31', memo: 'RENDIMENTO APLICACAO', documento: '', cents: 10315 },
];

// Lançamentos do sistema de origem. Os dias de pagamento ficam de 0 a 3 dias antes do extrato.
const LANCAMENTOS: Lancamento[] = [
  // (a) recebimentos NF 4501 a 4512 (desvio em dias: 2,1,0,3,1,2,0,3,1,0,2,3)
  { paymentDate: '2024-01-01', favorecido: 'ALFA DISTRIBUIDORA', descricao: 'Recebimento NF 4501', documento: '4501', cents: 18000, conta: 'MOVIMENTO' },
  { paymentDate: '2024-01-03', favorecido: 'BETA MATERIAIS', descricao: 'Recebimento NF 4502', documento: '4502', cents: 32550, conta: 'MOVIMENTO' },
  { paymentDate: '2024-01-05', favorecido: 'GAMA SERVICOS', descricao: 'Recebimento NF 4503', documento: '4503', cents: 61075, conta: 'MOVIMENTO' },
  { paymentDate: '2024-01-05', favorecido: 'DELTA ATACADO', descricao: 'Recebimento NF 4504', documento: '4504', cents: 94210, conta: 'MOVIMENTO' },
  { paymentDate: '2024-01-08', favorecido: 'ORION COMERCIO', descricao: 'Recebimento NF 4505', documento: '4505', cents: 118000, conta: 'MOVIMENTO' },
  { paymentDate: '2024-01-09', favorecido: 'VEGA ELETRO', descricao: 'Recebimento NF 4506', documento: '4506', cents: 149990, conta: 'MOVIMENTO' },
  { paymentDate: '2024-01-12', favorecido: 'ATLAS CONSTRUCOES', descricao: 'Recebimento NF 4507', documento: '4507', cents: 205000, conta: 'MOVIMENTO' },
  { paymentDate: '2024-01-13', favorecido: 'NOVA ALIANCA', descricao: 'Recebimento NF 4508', documento: '4508', cents: 238745, conta: 'MOVIMENTO' },
  { paymentDate: '2024-01-16', favorecido: 'PRIMA TEXTIL', descricao: 'Recebimento NF 4509', documento: '4509', cents: 312000, conta: 'MOVIMENTO' },
  { paymentDate: '2024-01-22', favorecido: 'ZENITH FARMA', descricao: 'Recebimento NF 4510', documento: '4510', cents: 367530, conta: 'MOVIMENTO' },
  { paymentDate: '2024-01-21', favorecido: 'CASA DO SUL', descricao: 'Recebimento NF 4511', documento: '4511', cents: 421000, conta: 'MOVIMENTO' },
  { paymentDate: '2024-01-23', favorecido: 'RIO BRANCO LTDA', descricao: 'Recebimento NF 4512', documento: '4512', cents: 490000, conta: 'MOVIMENTO' },
  // (b) pagamentos a fornecedores (desvio em dias: 1,0,2,0,3,1,2,0)
  { paymentDate: '2024-01-03', favorecido: 'PAPEL NORTE', descricao: 'Pagamento fornecedor', documento: '880101', cents: -85000, conta: 'MOVIMENTO' },
  { paymentDate: '2024-01-05', favorecido: 'METALURGICA SUL', descricao: 'Pagamento fornecedor', documento: '880102', cents: -127540, conta: 'MOVIMENTO' },
  { paymentDate: '2024-01-07', favorecido: 'TRANSPORTES RAPIDO', descricao: 'Pagamento fornecedor', documento: '880103', cents: -42000, conta: 'MOVIMENTO' },
  { paymentDate: '2024-01-12', favorecido: 'EMBALAGENS MINAS', descricao: 'Pagamento fornecedor', documento: '880104', cents: -301000, conta: 'MOVIMENTO' },
  { paymentDate: '2024-01-13', favorecido: 'LIMPEZA TOTAL', descricao: 'Pagamento fornecedor', documento: '880105', cents: -56025, conta: 'MOVIMENTO' },
  { paymentDate: '2024-01-19', favorecido: 'INFORMATICA PRIME', descricao: 'Pagamento fornecedor', documento: '880106', cents: -214000, conta: 'MOVIMENTO' },
  { paymentDate: '2024-01-23', favorecido: 'CARTONAGEM NORTE', descricao: 'Pagamento fornecedor', documento: '880107', cents: -79090, conta: 'MOVIMENTO' },
  { paymentDate: '2024-01-29', favorecido: 'GRAFICA VIDA', descricao: 'Pagamento fornecedor', documento: '880108', cents: -100515, conta: 'MOVIMENTO' },
  // (c) recebimentos sem documento (mesmo valor e data do extrato)
  { paymentDate: '2024-01-07', favorecido: 'LOJA BAIRRO NORTE', descricao: 'Recebimento sem documento', documento: null, cents: 26540, conta: 'MOVIMENTO' },
  { paymentDate: '2024-01-13', favorecido: 'LOJA SHOPPING', descricao: 'Recebimento sem documento', documento: null, cents: 51280, conta: 'MOVIMENTO' },
  { paymentDate: '2024-01-19', favorecido: 'LOJA AEROPORTO', descricao: 'Recebimento sem documento', documento: null, cents: 173860, conta: 'MOVIMENTO' },
  { paymentDate: '2024-01-25', favorecido: 'LOJA SÃO JOSÉ', descricao: 'Recebimento sem documento', documento: null, cents: 290315, conta: 'MOVIMENTO' },
  { paymentDate: '2024-01-30', favorecido: 'LOJA INDUSTRIAL', descricao: 'Recebimento sem documento', documento: null, cents: 331790, conta: 'MOVIMENTO' },
  // (d) avulsos de R$ 750,00 em 15/01
  { paymentDate: '2024-01-15', favorecido: 'CLIENTE AVULSO', descricao: 'Recebimento avulso', documento: null, cents: 75000, conta: 'MOVIMENTO' },
  { paymentDate: '2024-01-15', favorecido: 'CLIENTE AVULSO', descricao: 'Recebimento avulso', documento: null, cents: 75000, conta: 'MOVIMENTO' },
  // (e) NF 4520 com valor diferente do extrato
  { paymentDate: '2024-01-10', favorecido: 'MERCADO SOL NASCENTE', descricao: 'Recebimento NF 4520', documento: '4520', cents: 200000, conta: 'MOVIMENTO' },
  // (f) três lançamentos que somam o depósito de R$ 3.600,00
  { paymentDate: '2024-01-18', favorecido: 'ADQUIRENTE CARTOES', descricao: 'Lote de cartões', documento: null, cents: 100000, conta: 'MOVIMENTO' },
  { paymentDate: '2024-01-18', favorecido: 'ADQUIRENTE CARTOES', descricao: 'Lote de cartões', documento: null, cents: 120000, conta: 'MOVIMENTO' },
  { paymentDate: '2024-01-18', favorecido: 'ADQUIRENTE CARTOES', descricao: 'Lote de cartões', documento: null, cents: 140000, conta: 'MOVIMENTO' },
  // sem correspondência no extrato
  { paymentDate: '2024-01-16', favorecido: 'PAPELARIA CENTRAL', descricao: 'Compra de material de escritório', documento: '880150', cents: -45500, conta: 'MOVIMENTO' },
  { paymentDate: '2024-01-23', favorecido: 'CLIENTE GAMA SERVICOS', descricao: 'Recebimento previsto NF 4530', documento: '4530', cents: 125000, conta: 'MOVIMENTO' },
  { paymentDate: '2024-01-31', favorecido: 'CONTABILIDADE SILVA', descricao: 'Honorários mensais', documento: '880151', cents: -160000, conta: 'RESERVA' },
];

const PAGAMENTO_LANCAMENTO_DIAS = 0;

// ---------------------------------------------------------------------------
// Formatação
// ---------------------------------------------------------------------------

/** Centavos para texto decimal com ponto, por exemplo -8990 vira "-89.90". */
function dotAmount(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Centavos para formato brasileiro, por exemplo 1000000 vira "10.000,00". */
function brAmount(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.trunc(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}${whole},${String(abs % 100).padStart(2, '0')}`;
}

function ofxDate(date: string): string {
  return date.replace(/-/g, '');
}

function brDate(date: string): string {
  const [y, m, d] = date.split('-');
  return `${d}/${m}/${y}`;
}

function addDays(date: string, days: number): string {
  const time = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(time).toISOString().slice(0, 10);
}

/** Cabeçalho OFX 1.x SGML com codificação Windows-1252. */
function ofxHeader(): string {
  return [
    'OFXHEADER:100',
    'DATA:OFXSGML',
    'VERSION:102',
    'SECURITY:NONE',
    'ENCODING:USASCII',
    'CHARSET:1252',
    'COMPRESSION:NONE',
    'OLDFILEUID:NONE',
    'NEWFILEUID:NONE',
    '',
  ].join('\r\n');
}

function ofxDocument(start: string, end: string, transactions: Tx[]): string {
  const blocks = transactions
    .map(
      (tx) =>
        [
          '<STMTTRN>',
          `<TRNTYPE>${tx.cents < 0 ? 'DEBIT' : 'CREDIT'}`,
          `<DTPOSTED>${ofxDate(tx.date)}120000[-3:BRT]`,
          `<TRNAMT>${dotAmount(tx.cents)}`,
          `<FITID>${tx.fitId}`,
          `<MEMO>${tx.memo}`,
          '</STMTTRN>',
        ].join('\r\n'),
    )
    .join('\r\n');
  return [
    '<OFX>',
    '<SIGNONMSGSRSV1><SONRS>',
    '<STATUS><CODE>0<SEVERITY>INFO</STATUS>',
    '<DTSERVER>20240131120000[-3:BRT]',
    '<LANGUAGE>POR',
    '</SONRS></SIGNONMSGSRSV1>',
    '<BANKMSGSRSV1><STMTTRNRS>',
    '<TRNUID>1',
    '<STATUS><CODE>0<SEVERITY>INFO</STATUS>',
    '<STMTRS>',
    '<CURDEF>BRL',
    '<BANKACCTFROM>',
    `<BANKID>${BANK_ID}`,
    `<ACCTID>${ACCOUNT_ID}`,
    '<ACCTTYPE>CHECKING',
    '</BANKACCTFROM>',
    '<BANKTRANLIST>',
    `<DTSTART>${ofxDate(start)}`,
    `<DTEND>${ofxDate(end)}`,
    blocks,
    '</BANKTRANLIST>',
    '</STMTRS>',
    '</STMTTRNRS></BANKMSGSRSV1>',
    '</OFX>',
    '',
  ].join('\r\n');
}

function latin1(text: string): Buffer {
  return Buffer.from(text, 'latin1');
}

function movimentoFile(): DemoFile {
  return {
    name: 'extrato-movimento-2024-01.ofx',
    kind: 'bank',
    account: 'movimento',
    content: latin1(ofxHeader() + ofxDocument('2024-01-01', '2024-01-31', MOVIMENTO_JAN)),
  };
}

function complementoFile(): DemoFile {
  const repetidas = MOVIMENTO_JAN.filter((tx) => tx.date >= '2024-01-25');
  const transactions = [...repetidas, ...MOVIMENTO_COMPLEMENTO_NOVAS];
  return {
    name: 'extrato-movimento-2024-01-complemento.ofx',
    kind: 'bank',
    account: 'movimento',
    content: latin1(ofxHeader() + ofxDocument('2024-01-25', '2024-01-31', transactions)),
  };
}

function reservaFile(): DemoFile {
  const header = 'Data;Histórico;Documento;Valor;Saldo';
  let saldo = RESERVA_ABERTURA_CENTS;
  const lines = [header, `01/01/2024;SALDO ANTERIOR;;;${brAmount(saldo)}`];
  for (const mov of RESERVA_MOVIMENTOS) {
    saldo += mov.cents;
    lines.push(`${brDate(mov.date)};${mov.memo};${mov.documento};${brAmount(mov.cents)};${brAmount(saldo)}`);
  }
  return {
    name: 'extrato-reserva-2024-01.csv',
    kind: 'bank',
    account: 'reserva',
    content: Buffer.from(`${lines.join('\n')}\n`, 'utf8'),
  };
}

async function ledgerFile(): Promise<DemoFile> {
  const workbook = new ExcelJS.Workbook();
  // Data fixa nos metadados: sem ela, cada geração teria bytes diferentes.
  workbook.created = new Date(Date.UTC(2024, 0, 31));
  workbook.modified = new Date(Date.UTC(2024, 0, 31));
  const sheet = workbook.addWorksheet('Lançamentos');
  sheet.addRow(['ID', 'Data Pagamento', 'Vencimento', 'Favorecido', 'Descrição', 'Documento', 'Valor', 'Conta']);
  LANCAMENTOS.forEach((item, index) => {
    const toDate = (value: string) => {
      const [y, m, d] = value.split('-').map(Number);
      return new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1));
    };
    sheet.addRow([
      `LC-${String(index + 1).padStart(4, '0')}`,
      toDate(item.paymentDate),
      toDate(addDays(item.paymentDate, PAGAMENTO_LANCAMENTO_DIAS)),
      item.favorecido,
      item.descricao,
      item.documento,
      item.cents / 100,
      item.conta,
    ]);
  });
  sheet.getColumn(2).numFmt = 'dd/mm/yyyy';
  sheet.getColumn(3).numFmt = 'dd/mm/yyyy';
  sheet.getColumn(7).numFmt = '#,##0.00';
  const buffer = await workbook.xlsx.writeBuffer();
  return {
    name: 'lancamentos-2024-01.xlsx',
    kind: 'ledger',
    account: null,
    content: Buffer.from(buffer),
  };
}

/** Gera os quatro arquivos de demonstração. Determinístico: mesma saída a cada chamada. */
export async function buildDemoFiles(): Promise<DemoFile[]> {
  return [movimentoFile(), complementoFile(), reservaFile(), await ledgerFile()];
}
