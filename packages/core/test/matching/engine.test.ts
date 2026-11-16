import { describe, expect, it } from 'vitest';
import { pairKey, reconcile } from '../../src/matching/engine';
import { DEFAULT_RECON_RULES, reconRulesSchema, type ReconRules } from '../../src/matching/rules';
import type { ProposedMatch, ReconItem } from '../../src/matching/types';

let sequence = 0;
function item(side: 'bank' | 'ledger', overrides: Partial<ReconItem> = {}): ReconItem {
  sequence += 1;
  return {
    id: `${side[0]}${sequence}`,
    side,
    accountId: 'conta-1',
    date: '2024-01-05',
    amountCents: 10000,
    descriptionNorm: '',
    identifiers: [],
    kind: 'regular',
    categoryId: null,
    ...overrides,
  };
}
const bank = (overrides: Partial<ReconItem> = {}) => item('bank', overrides);
const ledger = (overrides: Partial<ReconItem> = {}) => item('ledger', overrides);

function rules(overrides: Record<string, unknown> = {}): ReconRules {
  return reconRulesSchema.parse({ ...DEFAULT_RECON_RULES, ...overrides });
}

const autos = (matches: ProposedMatch[]) => matches.filter((match) => match.decision === 'auto');
const suggestions = (matches: ProposedMatch[]) => matches.filter((match) => match.decision === 'suggest');

describe('regra de identificador', () => {
  it('concilia automaticamente par único com mesmo identificador e mesmo valor', () => {
    const b = bank({ identifiers: ['4512'], date: '2024-01-08' });
    const l = ledger({ identifiers: ['4512'], date: '2024-01-05' });
    const { matches } = reconcile({ bank: [b], ledger: [l], rules: rules() });

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      decision: 'auto',
      type: 'identifier',
      ruleCode: 'ID_VALOR',
      bankIds: [b.id],
      ledgerIds: [l.id],
      differenceCents: 0,
      dateDiffDays: 3,
      divergence: null,
      ambiguous: false,
    });
    expect(matches[0]?.confidence).toBeGreaterThan(0.8);
  });

  it('gera divergência de valor, sem conciliar, quando o identificador é igual e o valor é diferente', () => {
    const b = bank({ identifiers: ['4512'], amountCents: 10000 });
    const l = ledger({ identifiers: ['4512'], amountCents: 10550 });
    const { matches } = reconcile({ bank: [b], ledger: [l], rules: rules() });

    expect(autos(matches)).toEqual([]);
    expect(matches).toEqual([
      expect.objectContaining({
        decision: 'suggest',
        ruleCode: 'ID_VALOR_DIVERGENTE',
        divergence: 'amount',
        differenceCents: -550,
      }),
    ]);
  });

  it('gera divergência de data quando identificador e valor conferem mas a data excede o limite', () => {
    const b = bank({ identifiers: ['4512'], date: '2024-03-01' });
    const l = ledger({ identifiers: ['4512'], date: '2024-01-05' });
    const { matches } = reconcile({ bank: [b], ledger: [l], rules: rules({ identifierMaxDateDiffDays: 10 }) });

    expect(matches).toEqual([
      expect.objectContaining({ decision: 'suggest', ruleCode: 'ID_VALOR_DATA_FORA', divergence: 'date' }),
    ]);
  });

  it('não concilia quando o mesmo identificador e valor aparecem em dois lançamentos', () => {
    const b = bank({ identifiers: ['4512'] });
    const l1 = ledger({ identifiers: ['4512'] });
    const l2 = ledger({ identifiers: ['4512'] });
    const { matches } = reconcile({ bank: [b], ledger: [l1, l2], rules: rules() });

    expect(autos(matches)).toEqual([]);
    expect(suggestions(matches)).toHaveLength(2);
    expect(matches.every((match) => match.ambiguous)).toBe(true);
  });

  it('usa o valor para escolher entre parcelas com o mesmo identificador', () => {
    const b = bank({ identifiers: ['4512'], amountCents: 20000 });
    const l1 = ledger({ identifiers: ['4512'], amountCents: 10000 });
    const l2 = ledger({ identifiers: ['4512'], amountCents: 20000 });
    const { matches } = reconcile({ bank: [b], ledger: [l1, l2], rules: rules() });

    expect(autos(matches)).toEqual([expect.objectContaining({ ruleCode: 'ID_VALOR', ledgerIds: [l2.id] })]);
  });

  it('ignora identificadores curtos demais', () => {
    const b = bank({ identifiers: ['12'], date: '2024-01-05' });
    const l = ledger({ identifiers: ['12'], date: '2024-02-20' });
    const { matches } = reconcile({ bank: [b], ledger: [l], rules: rules() });
    expect(matches).toEqual([]);
  });

  it('vira sugestão quando a conciliação automática por identificador está desligada', () => {
    const b = bank({ identifiers: ['4512'] });
    const l = ledger({ identifiers: ['4512'] });
    const { matches } = reconcile({
      bank: [b],
      ledger: [l],
      rules: rules({ autoConfirm: { ...DEFAULT_RECON_RULES.autoConfirm, byIdentifier: false } }),
    });
    expect(matches).toEqual([expect.objectContaining({ decision: 'suggest', ruleCode: 'ID_VALOR' })]);
  });
});

describe('regra de valor e data', () => {
  it('concilia automaticamente candidato único dentro da tolerância de data', () => {
    const b = bank({ date: '2024-01-07' });
    const l = ledger({ date: '2024-01-05' });
    const { matches } = reconcile({ bank: [b], ledger: [l], rules: rules({ dateToleranceDays: 2 }) });
    expect(matches).toEqual([
      expect.objectContaining({ decision: 'auto', type: 'amount_date', ruleCode: 'VALOR_DATA_UNICO', dateDiffDays: 2 }),
    ]);
  });

  it('registra a regra com referência quando data é igual e as descrições coincidem', () => {
    const b = bank({ descriptionNorm: 'PIX RECEBIDO PADARIA BOM PAO' });
    const l = ledger({ descriptionNorm: 'VENDA PADARIA BOM PAO' });
    const { matches } = reconcile({ bank: [b], ledger: [l], rules: rules() });
    expect(matches).toEqual([expect.objectContaining({ decision: 'auto', ruleCode: 'VALOR_DATA_REFERENCIA' })]);
  });

  it('não propõe nada fora da tolerância de data', () => {
    const b = bank({ date: '2024-01-10' });
    const l = ledger({ date: '2024-01-05' });
    const { matches } = reconcile({ bank: [b], ledger: [l], rules: rules({ dateToleranceDays: 2 }) });
    expect(matches).toEqual([]);
  });

  it('gera sugestões, e nenhuma conciliação, quando há dois lançamentos candidatos', () => {
    const b = bank({ descriptionNorm: 'PIX RECEBIDO CLIENTE BETA' });
    const l1 = ledger({ descriptionNorm: 'ALUGUEL SALA DOIS' });
    const l2 = ledger({ descriptionNorm: 'MENSALIDADE CLIENTE BETA' });
    const { matches } = reconcile({ bank: [b], ledger: [l1, l2], rules: rules() });

    expect(autos(matches)).toEqual([]);
    expect(suggestions(matches)).toHaveLength(2);
    expect(matches.every((match) => match.ambiguous && match.ruleCode === 'VALOR_DATA_AMBIGUO')).toBe(true);
    expect(matches[0]?.ledgerIds).toEqual([l2.id]);
    expect(matches[0]!.confidence).toBeGreaterThan(matches[1]!.confidence);
    expect(matches[0]?.breakdown.competitors).toBe(2);
  });

  it('gera sugestões, e nenhuma conciliação, quando duas transações disputam um lançamento', () => {
    const b1 = bank();
    const b2 = bank();
    const l = ledger();
    const { matches } = reconcile({ bank: [b1, b2], ledger: [l], rules: rules() });
    expect(autos(matches)).toEqual([]);
    expect(suggestions(matches).map((match) => match.bankIds[0]).sort()).toEqual([b1.id, b2.id].sort());
  });

  it('considera ambíguo o candidato de outro dia dentro da tolerância, mesmo havendo um do mesmo dia', () => {
    const b = bank({ date: '2024-01-05' });
    const l1 = ledger({ date: '2024-01-05' });
    const l2 = ledger({ date: '2024-01-06' });
    const { matches } = reconcile({ bank: [b], ledger: [l1, l2], rules: rules({ dateToleranceDays: 2 }) });
    expect(autos(matches)).toEqual([]);
    expect(matches[0]?.ledgerIds).toEqual([l1.id]);
  });

  it('nunca casa entrada com saída', () => {
    const b = bank({ amountCents: 10000 });
    const l = ledger({ amountCents: -10000 });
    expect(reconcile({ bank: [b], ledger: [l], rules: rules() }).matches).toEqual([]);
  });

  it('limita a quantidade de sugestões por item', () => {
    const b = bank();
    const candidates = Array.from({ length: 6 }, () => ledger());
    const { matches } = reconcile({
      bank: [b],
      ledger: candidates,
      rules: rules({ suggestions: { minConfidence: 0, maxPerItem: 3 } }),
    });
    expect(matches).toHaveLength(3);
  });

  it('vira sugestão quando a conciliação automática por candidato único está desligada', () => {
    const { matches } = reconcile({
      bank: [bank()],
      ledger: [ledger()],
      rules: rules({
        autoConfirm: { ...DEFAULT_RECON_RULES.autoConfirm, byUniqueAmountDate: false, byAmountDateReference: false },
      }),
    });
    expect(matches).toEqual([expect.objectContaining({ decision: 'suggest', ambiguous: false })]);
  });
});

describe('tolerância de valor', () => {
  it('sugere, com divergência de valor, par dentro da tolerância em centavos', () => {
    const b = bank({ amountCents: 10000 });
    const l = ledger({ amountCents: 10050 });
    const { matches } = reconcile({ bank: [b], ledger: [l], rules: rules({ amountToleranceCents: 100 }) });
    expect(matches).toEqual([
      expect.objectContaining({
        decision: 'suggest',
        type: 'tolerance',
        ruleCode: 'TOLERANCIA_VALOR',
        divergence: 'amount',
        differenceCents: -50,
      }),
    ]);
  });

  it('aceita tolerância percentual', () => {
    const b = bank({ amountCents: 100000 });
    const l = ledger({ amountCents: 100900 });
    expect(reconcile({ bank: [b], ledger: [l], rules: rules({ amountTolerancePercent: 1 }) }).matches).toHaveLength(1);
    expect(reconcile({ bank: [b], ledger: [l], rules: rules({ amountTolerancePercent: 0.5 }) }).matches).toHaveLength(0);
  });

  it('não propõe nada com tolerância zero', () => {
    const b = bank({ amountCents: 10000 });
    const l = ledger({ amountCents: 10001 });
    expect(reconcile({ bank: [b], ledger: [l], rules: rules() }).matches).toEqual([]);
  });
});

describe('agrupamento', () => {
  it('sugere uma transação bancária como soma de vários lançamentos, sem conciliar', () => {
    const b = bank({ amountCents: 30000 });
    const l1 = ledger({ amountCents: 10000 });
    const l2 = ledger({ amountCents: 20000 });
    const l3 = ledger({ amountCents: 7000 });
    const { matches } = reconcile({ bank: [b], ledger: [l1, l2, l3], rules: rules() });
    expect(matches).toEqual([
      expect.objectContaining({
        decision: 'suggest',
        type: 'group',
        ruleCode: 'AGRUPAMENTO',
        bankIds: [b.id],
        ledgerIds: [l1.id, l2.id].sort(),
        differenceCents: 0,
      }),
    ]);
  });

  it('sugere um lançamento como soma de várias transações bancárias', () => {
    const l = ledger({ amountCents: -45000 });
    const b1 = bank({ amountCents: -15000 });
    const b2 = bank({ amountCents: -30000 });
    const { matches } = reconcile({ bank: [b1, b2], ledger: [l], rules: rules() });
    expect(matches).toEqual([
      expect.objectContaining({ type: 'group', bankIds: [b1.id, b2.id].sort(), ledgerIds: [l.id] }),
    ]);
  });

  it('marca como ambíguo quando há mais de uma combinação possível', () => {
    const b = bank({ amountCents: 30000 });
    const parts = [ledger({ amountCents: 10000 }), ledger({ amountCents: 20000 }), ledger({ amountCents: 15000 }), ledger({ amountCents: 15000 })];
    const { matches } = reconcile({ bank: [b], ledger: parts, rules: rules() });
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches.every((match) => match.type === 'group' && match.ambiguous)).toBe(true);
  });

  it('não agrupa quando o módulo está desligado', () => {
    const b = bank({ amountCents: 30000 });
    const { matches } = reconcile({
      bank: [b],
      ledger: [ledger({ amountCents: 10000 }), ledger({ amountCents: 20000 })],
      rules: rules({ grouping: { ...DEFAULT_RECON_RULES.grouping, enabled: false } }),
    });
    expect(matches).toEqual([]);
  });
});

describe('transferências internas', () => {
  const out = () => bank({ accountId: 'conta-1', amountCents: -50000, kind: 'internal_transfer' });
  const into = () => bank({ accountId: 'conta-2', amountCents: 50000, kind: 'internal_transfer' });

  it('sugere o par débito/crédito entre duas contas da empresa', () => {
    const debit = out();
    const credit = into();
    const { matches } = reconcile({ bank: [debit], ledger: [], otherAccountsBank: [credit], rules: rules() });
    expect(matches).toEqual([
      expect.objectContaining({
        decision: 'suggest',
        type: 'internal_transfer',
        ruleCode: 'TRANSFERENCIA_INTERNA',
        bankIds: [debit.id, credit.id].sort(),
        ledgerIds: [],
      }),
    ]);
  });

  it('concilia automaticamente quando configurado e o par é único', () => {
    const { matches } = reconcile({
      bank: [out()],
      ledger: [],
      otherAccountsBank: [into()],
      rules: rules({ autoConfirm: { ...DEFAULT_RECON_RULES.autoConfirm, internalTransfers: true } }),
    });
    expect(matches).toEqual([expect.objectContaining({ decision: 'auto', type: 'internal_transfer' })]);
  });

  it('não propõe transferência quando nenhuma das pontas foi classificada como transferência', () => {
    const debit = bank({ accountId: 'conta-1', amountCents: -50000 });
    const credit = bank({ accountId: 'conta-2', amountCents: 50000 });
    const { matches } = reconcile({ bank: [debit], ledger: [], otherAccountsBank: [credit], rules: rules() });
    expect(matches).toEqual([]);
  });

  it('não pareia duas transações da mesma conta como transferência', () => {
    const debit = out();
    const credit = bank({ accountId: 'conta-1', amountCents: 50000, kind: 'internal_transfer' });
    const { matches } = reconcile({ bank: [debit, credit], ledger: [], rules: rules() });
    expect(matches.filter((match) => match.type === 'internal_transfer')).toEqual([]);
  });

  it('prefere o lançamento do sistema à transferência quando ambos existem', () => {
    const debit = out();
    const entry = ledger({ amountCents: -50000 });
    const { matches } = reconcile({ bank: [debit], ledger: [entry], otherAccountsBank: [into()], rules: rules() });
    expect(matches).toEqual([expect.objectContaining({ decision: 'auto', type: 'amount_date' })]);
  });
});

describe('estornos', () => {
  it('sugere o par transação original e estorno na mesma conta', () => {
    const original = bank({ amountCents: -8000, date: '2024-01-05', descriptionNorm: 'PAGTO FORNECEDOR GAMA' });
    const reversal = bank({ amountCents: 8000, date: '2024-01-09', kind: 'reversal', descriptionNorm: 'ESTORNO PAGTO FORNECEDOR GAMA' });
    const { matches } = reconcile({ bank: [original, reversal], ledger: [], rules: rules() });
    expect(matches).toEqual([
      expect.objectContaining({
        decision: 'suggest',
        type: 'reversal',
        ruleCode: 'ESTORNO',
        bankIds: [original.id, reversal.id].sort(),
      }),
    ]);
  });

  it('não pareia estorno com transação posterior a ele', () => {
    const reversal = bank({ amountCents: 8000, date: '2024-01-05', kind: 'reversal' });
    const later = bank({ amountCents: -8000, date: '2024-01-09' });
    const { matches } = reconcile({ bank: [reversal, later], ledger: [], rules: rules() });
    expect(matches).toEqual([]);
  });

  it('respeita a janela de dias', () => {
    const original = bank({ amountCents: -8000, date: '2024-01-05' });
    const reversal = bank({ amountCents: 8000, date: '2024-03-20', kind: 'reversal' });
    const { matches } = reconcile({ bank: [original, reversal], ledger: [], rules: rules() });
    expect(matches).toEqual([]);
  });
});

describe('tarifas e encargos', () => {
  it('sugere classificação para tarifa sem lançamento correspondente', () => {
    const fee = bank({ amountCents: -3590, kind: 'fee', categoryId: 'cat-tarifas' });
    const { matches } = reconcile({ bank: [fee], ledger: [], rules: rules() });
    expect(matches).toEqual([
      expect.objectContaining({
        decision: 'suggest',
        type: 'classification',
        ruleCode: 'CLASSIFICACAO_REGRA',
        bankIds: [fee.id],
        ledgerIds: [],
        categoryId: 'cat-tarifas',
      }),
    ]);
  });

  it('classifica automaticamente quando configurado', () => {
    const { matches } = reconcile({
      bank: [bank({ amountCents: -3590, kind: 'tax' })],
      ledger: [],
      rules: rules({ autoConfirm: { ...DEFAULT_RECON_RULES.autoConfirm, fees: true } }),
    });
    expect(matches).toEqual([expect.objectContaining({ decision: 'auto', type: 'classification' })]);
  });

  it('prefere o lançamento do sistema quando a tarifa foi lançada', () => {
    const fee = bank({ amountCents: -3590, kind: 'fee' });
    const entry = ledger({ amountCents: -3590 });
    const { matches } = reconcile({ bank: [fee], ledger: [entry], rules: rules() });
    expect(matches).toEqual([expect.objectContaining({ type: 'amount_date', decision: 'auto' })]);
  });
});

describe('propriedades gerais', () => {
  it('não volta a propor par rejeitado, nem o concilia automaticamente', () => {
    const b = bank({ identifiers: ['4512'] });
    const l = ledger({ identifiers: ['4512'] });
    const { matches } = reconcile({
      bank: [b],
      ledger: [l],
      rejectedPairs: new Set([pairKey([b.id], [l.id])]),
      rules: rules(),
    });
    expect(matches).toEqual([]);
  });

  it('não concilia sozinho o candidato que sobra depois de uma rejeição humana', () => {
    const b = bank();
    const l1 = ledger();
    const l2 = ledger();
    const { matches } = reconcile({
      bank: [b],
      ledger: [l1, l2],
      rejectedPairs: new Set([pairKey([b.id], [l1.id])]),
      rules: rules(),
    });
    expect(matches).toEqual([
      expect.objectContaining({ decision: 'suggest', ambiguous: true, bankIds: [b.id], ledgerIds: [l2.id] }),
    ]);
  });

  it('aplica a mesma cautela na regra de identificador', () => {
    const b = bank({ identifiers: ['4512'] });
    const l1 = ledger({ identifiers: ['4512'] });
    const l2 = ledger({ identifiers: ['4512'] });
    const { matches } = reconcile({
      bank: [b],
      ledger: [l1, l2],
      rejectedPairs: new Set([pairKey([b.id], [l1.id])]),
      rules: rules(),
    });
    expect(matches).toEqual([
      expect.objectContaining({ decision: 'suggest', ruleCode: 'ID_VALOR', ambiguous: true, ledgerIds: [l2.id] }),
    ]);
  });

  it('produz o mesmo resultado para qualquer ordem de entrada', () => {
    const bankItems = [
      bank({ identifiers: ['7001'], amountCents: 12000 }),
      bank({ amountCents: 5000 }),
      bank({ amountCents: 5000 }),
      bank({ amountCents: -3590, kind: 'fee' }),
      bank({ amountCents: 30000 }),
    ];
    const ledgerItems = [
      ledger({ identifiers: ['7001'], amountCents: 12000 }),
      ledger({ amountCents: 5000 }),
      ledger({ amountCents: 10000 }),
      ledger({ amountCents: 20000 }),
    ];
    const first = reconcile({ bank: bankItems, ledger: ledgerItems, rules: rules() });
    const second = reconcile({ bank: [...bankItems].reverse(), ledger: [...ledgerItems].reverse(), rules: rules() });
    expect(second).toEqual(first);
    expect(first.engineVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('nunca usa o mesmo item em duas conciliações automáticas e só concilia valores exatos', () => {
    let seed = 42;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const amounts = [1000, 2500, 2500, 9990, 12000, 15000];
    const make = (side: 'bank' | 'ledger') =>
      Array.from({ length: 120 }, () =>
        item(side, {
          amountCents: amounts[Math.floor(random() * amounts.length)]! * (random() < 0.3 ? -1 : 1),
          date: `2024-01-${String(1 + Math.floor(random() * 20)).padStart(2, '0')}`,
          identifiers: random() < 0.2 ? [String(5000 + Math.floor(random() * 15))] : [],
        }),
      );
    const bankItems = make('bank');
    const ledgerItems = make('ledger');
    const byId = new Map([...bankItems, ...ledgerItems].map((entry) => [entry.id, entry]));
    const { matches, stats } = reconcile({ bank: bankItems, ledger: ledgerItems, rules: rules() });

    const used = new Set<string>();
    for (const match of autos(matches)) {
      for (const id of [...match.bankIds, ...match.ledgerIds]) {
        expect(used.has(id)).toBe(false);
        used.add(id);
      }
      const sum = (ids: string[]) => ids.reduce((total, id) => total + byId.get(id)!.amountCents, 0);
      expect(sum(match.bankIds)).toBe(sum(match.ledgerIds));
    }
    for (const match of suggestions(matches)) {
      for (const id of [...match.bankIds, ...match.ledgerIds]) expect(used.has(id)).toBe(false);
    }
    expect(stats.autoMatched).toBe(autos(matches).length);
    expect(stats.suggested).toBe(suggestions(matches).length);
  });

  it('informa explicação legível para cada resultado', () => {
    const { matches } = reconcile({
      bank: [bank({ identifiers: ['4512'] })],
      ledger: [ledger({ identifiers: ['4512'] })],
      rules: rules(),
    });
    expect(matches[0]?.explanation).toMatch(/identificador/i);
  });
});
