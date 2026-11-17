import { describe, expect, it } from 'vitest';
import { decodeOfxBuffer, parseOfx } from '../../src/parsers/ofx';

/** OFX 1.x fictício no estilo de bancos brasileiros: SGML, sem tags de fechamento nos campos. */
const SGML = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS><DTSERVER>20240131120000[-3:BRT]<LANGUAGE>POR</SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<STMTRS>
<CURDEF>BRL
<BANKACCTFROM><BANKID>0999<BRANCHID>1234<ACCTID>00056789-0<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20240101000000[-3:BRT]
<DTEND>20240131000000[-3:BRT]
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20240105000000[-3:BRT]
<TRNAMT>1500.00
<FITID>2024010500001
<CHECKNUM>004512
<MEMO>PIX RECEBIDO PADARIA BOM PÃO NF 4512
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20240108000000[-3:BRT]
<TRNAMT>-35,90
<FITID>2024010800002
<MEMO>TARIFA PACOTE SERVIÇOS
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20240110000000[-3:BRT]
<TRNAMT>250.00
<FITID>2024011000003
<NAME>FORNECEDOR ALFA
<MEMO>PAGTO TITULO &amp; JUROS
</STMTTRN>
<STMTTRN>
<TRNTYPE>OTHER
<DTPOSTED>20241340
<TRNAMT>10.00
<FITID>RUIM
<MEMO>DATA INVALIDA
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>12345.67<DTASOF>20240131000000[-3:BRT]</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<?OFX OFXHEADER="200" VERSION="211" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL</CURDEF>
<BANKACCTFROM><BANKID>0998</BANKID><ACCTID>778899</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>
<BANKTRANLIST><DTSTART>20240201</DTSTART><DTEND>20240229</DTEND>
<STMTTRN><TRNTYPE>XFER</TRNTYPE><DTPOSTED>20240215</DTPOSTED><TRNAMT>-1000.00</TRNAMT><FITID>ABC-1</FITID><REFNUM>778899</REFNUM><MEMO>TRANSF ENTRE CONTAS</MEMO></STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

describe('parseOfx (SGML 1.x)', () => {
  const [statement] = parseOfx(SGML);

  it('lê os dados da conta e do período', () => {
    expect(statement).toMatchObject({
      bankId: '0999',
      branchId: '1234',
      accountId: '00056789-0',
      currency: 'BRL',
      startDate: '2024-01-01',
      endDate: '2024-01-31',
      ledgerBalanceCents: 1234567,
      ledgerBalanceDate: '2024-01-31',
    });
  });

  it('lê transações sem tag de fechamento, com data civil e valor em centavos', () => {
    expect(statement?.transactions[0]).toMatchObject({
      fitId: '2024010500001',
      type: 'CREDIT',
      postedDate: '2024-01-05',
      amountCents: 150000,
      checkNumber: '004512',
      memo: 'PIX RECEBIDO PADARIA BOM PÃO NF 4512',
    });
  });

  it('aceita vírgula decimal', () => {
    expect(statement?.transactions[1]?.amountCents).toBe(-3590);
  });

  it('torna negativo o valor positivo de transação do tipo DEBIT e decodifica entidades', () => {
    expect(statement?.transactions[2]).toMatchObject({
      amountCents: -25000,
      name: 'FORNECEDOR ALFA',
      memo: 'PAGTO TITULO & JUROS',
    });
  });

  it('separa transação inválida como erro sem perder as demais', () => {
    expect(statement?.transactions).toHaveLength(3);
    expect(statement?.errors).toHaveLength(1);
    expect(statement?.errors[0]?.index).toBe(3);
    expect(statement?.errors[0]?.message).toMatch(/data/i);
  });
});

describe('parseOfx (XML 2.x)', () => {
  it('lê transações com tags de fechamento', () => {
    const [statement] = parseOfx(XML);
    expect(statement?.accountId).toBe('778899');
    expect(statement?.transactions).toEqual([
      expect.objectContaining({
        fitId: 'ABC-1',
        type: 'XFER',
        postedDate: '2024-02-15',
        amountCents: -100000,
        refNumber: '778899',
        memo: 'TRANSF ENTRE CONTAS',
      }),
    ]);
  });
});

describe('parseOfx (entrada inválida)', () => {
  it('devolve lista vazia quando não há extrato', () => {
    expect(parseOfx('isto não é OFX')).toEqual([]);
  });
});

describe('decodeOfxBuffer', () => {
  it('decodifica Windows-1252 conforme o cabeçalho', () => {
    const bytes = Buffer.from(SGML, 'latin1');
    expect(decodeOfxBuffer(bytes)).toContain('PADARIA BOM PÃO');
  });

  it('decodifica UTF-8', () => {
    const bytes = Buffer.from(XML.replace('ENTRE CONTAS', 'ENTRE CONTAS AÇÃO'), 'utf8');
    expect(decodeOfxBuffer(bytes)).toContain('AÇÃO');
  });

  it('recorre a Windows-1252 quando o cabeçalho diz UTF-8 mas os bytes não são UTF-8 válido', () => {
    const bytes = Buffer.from(XML.replace('ENTRE CONTAS', 'AÇÃO'), 'latin1');
    expect(decodeOfxBuffer(bytes)).toContain('AÇÃO');
  });
});
