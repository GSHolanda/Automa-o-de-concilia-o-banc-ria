import { ITEM_KIND_LABELS } from '../classification';
import { diffDays } from '../dates';
import { formatBRL } from '../money';
import { diceSimilarity, tokenize } from '../text';
import type { ReconRules } from './rules';
import type {
  EngineMatchType,
  ProposedMatch,
  ReconInput,
  ReconItem,
  ReconOutput,
  RuleCode,
  ScoreBreakdown,
} from './types';

/** Muda sempre que o comportamento do motor muda; fica gravada em cada execução. */
export const ENGINE_VERSION = '1.0.0';

const WEIGHTS = { amount: 0.35, date: 0.15, identifier: 0.2, description: 0.1, uniqueness: 0.2 };
const DESCRIPTION_MATCH_THRESHOLD = 0.5;
const GROUP_SOLUTION_LIMIT = 3;

/** Chave estável de um conjunto de itens; usada para lembrar sugestões rejeitadas. */
export function pairKey(bankIds: readonly string[], ledgerIds: readonly string[]): string {
  return `b:${[...bankIds].sort().join(',')}|l:${[...ledgerIds].sort().join(',')}`;
}

function byDateThenId(a: ReconItem, b: ReconItem): number {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function sameSign(a: number, b: number): boolean {
  return (a > 0 && b > 0) || (a < 0 && b < 0);
}

function sharedIdentifier(a: ReconItem, b: ReconItem, minLength: number): string | null {
  if (a.identifiers.length === 0 || b.identifiers.length === 0) return null;
  const other = new Set(b.identifiers);
  for (const identifier of a.identifiers) {
    if (identifier.length >= minLength && other.has(identifier)) return identifier;
  }
  return null;
}

class Engine {
  private readonly rules: ReconRules;
  private readonly rejected: ReadonlySet<string>;
  private readonly tokens = new Map<string, string[]>();
  /** Itens consumidos por conciliação automática. */
  private readonly used = new Set<string>();
  /** Itens usados ou citados em alguma sugestão: não podem mais ser conciliados automaticamente. */
  private readonly claimed = new Set<string>();
  readonly matches: ProposedMatch[] = [];

  constructor(
    private readonly bank: ReconItem[],
    private readonly ledger: ReconItem[],
    private readonly otherBank: ReconItem[],
    input: ReconInput,
  ) {
    this.rules = input.rules;
    this.rejected = input.rejectedPairs ?? new Set();
  }

  // -- utilitários ---------------------------------------------------------

  private tokensOf(item: ReconItem): string[] {
    let tokens = this.tokens.get(item.id);
    if (!tokens) {
      tokens = tokenize(item.descriptionNorm);
      this.tokens.set(item.id, tokens);
    }
    return tokens;
  }

  private similarity(a: ReconItem, b: ReconItem): number {
    return diceSimilarity(this.tokensOf(a), this.tokensOf(b));
  }

  private isRejected(bankIds: string[], ledgerIds: string[]): boolean {
    return this.rejected.has(pairKey(bankIds, ledgerIds));
  }

  private free(item: ReconItem): boolean {
    return !this.claimed.has(item.id);
  }

  private amountTolerance(amountCents: number): number {
    const percent = Math.floor((Math.abs(amountCents) * this.rules.amountTolerancePercent) / 100);
    return Math.max(this.rules.amountToleranceCents, percent);
  }

  private pairBreakdown(b: ReconItem, l: ReconItem, dateScale: number, competitors: number): ScoreBreakdown {
    const difference = Math.abs(b.amountCents - l.amountCents);
    const largest = Math.max(Math.abs(b.amountCents), Math.abs(l.amountCents), 1);
    const days = Math.abs(diffDays(l.date, b.date));
    return {
      amount: difference === 0 ? 1 : round4(Math.max(0, 1 - difference / largest) * 0.9),
      date: round4(Math.max(0, 1 - days / (dateScale + 1))),
      identifier: sharedIdentifier(b, l, this.rules.minIdentifierLength) ? 1 : 0,
      description: round4(this.similarity(b, l)),
      competitors: Math.max(1, competitors),
    };
  }

  private confidenceOf(breakdown: ScoreBreakdown): number {
    return round4(
      WEIGHTS.amount * breakdown.amount +
        WEIGHTS.date * breakdown.date +
        WEIGHTS.identifier * breakdown.identifier +
        WEIGHTS.description * breakdown.description +
        WEIGHTS.uniqueness * (1 / breakdown.competitors),
    );
  }

  private push(match: ProposedMatch): void {
    if (match.decision === 'suggest' && match.confidence < this.rules.suggestions.minConfidence) return;
    const ids = [...match.bankIds, ...match.ledgerIds];
    if (match.decision === 'auto') for (const id of ids) this.used.add(id);
    for (const id of ids) this.claimed.add(id);
    this.matches.push(match);
  }

  private pair(
    type: EngineMatchType,
    ruleCode: RuleCode,
    decision: 'auto' | 'suggest',
    b: ReconItem,
    l: ReconItem,
    options: {
      dateScale: number;
      competitors: number;
      divergence?: 'amount' | 'date' | null;
      ambiguous?: boolean;
      explanation: string;
    },
  ): ProposedMatch {
    const breakdown = this.pairBreakdown(b, l, options.dateScale, options.competitors);
    return {
      type,
      decision,
      ruleCode,
      bankIds: [b.id],
      ledgerIds: [l.id],
      confidence: this.confidenceOf(breakdown),
      breakdown,
      differenceCents: b.amountCents - l.amountCents,
      dateDiffDays: Math.abs(diffDays(l.date, b.date)),
      divergence: options.divergence ?? null,
      ambiguous: options.ambiguous ?? false,
      categoryId: null,
      explanation: options.explanation,
    };
  }

  private byConfidence(a: ProposedMatch, b: ProposedMatch): number {
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    if (a.dateDiffDays !== b.dateDiffDays) return a.dateDiffDays - b.dateDiffDays;
    const keyA = pairKey(a.bankIds, a.ledgerIds);
    const keyB = pairKey(b.bankIds, b.ledgerIds);
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  }

  // -- fase 1: identificador ----------------------------------------------

  private phaseIdentifier(): void {
    const { minIdentifierLength, identifierMaxDateDiffDays: maxDays } = this.rules;
    const index = new Map<string, ReconItem[]>();
    for (const l of this.ledger) {
      for (const identifier of new Set(l.identifiers)) {
        if (identifier.length < minIdentifierLength) continue;
        const list = index.get(identifier);
        if (list) list.push(l);
        else index.set(identifier, [l]);
      }
    }

    const edges = new Map<string, ReconItem[]>();
    const reverse = new Map<string, ReconItem[]>();
    const exact = new Map<string, ReconItem[]>();
    const exactReverse = new Map<string, ReconItem[]>();
    const add = (map: Map<string, ReconItem[]>, key: string, value: ReconItem) => {
      const list = map.get(key);
      if (list) list.push(value);
      else map.set(key, [value]);
    };

    for (const b of this.bank) {
      const seen = new Set<string>();
      for (const identifier of b.identifiers) {
        if (identifier.length < minIdentifierLength) continue;
        for (const l of index.get(identifier) ?? []) {
          if (seen.has(l.id)) continue;
          seen.add(l.id);
          if (!sameSign(b.amountCents, l.amountCents) || this.isRejected([b.id], [l.id])) continue;
          add(edges, b.id, l);
          add(reverse, l.id, b);
          if (b.amountCents === l.amountCents) {
            add(exact, b.id, l);
            add(exactReverse, l.id, b);
          }
        }
      }
    }

    for (const b of this.bank) {
      const exactCandidates = exact.get(b.id) ?? [];
      const only = exactCandidates[0];

      if (exactCandidates.length === 1 && only && (exactReverse.get(only.id) ?? []).length === 1) {
        const identifier = sharedIdentifier(b, only, minIdentifierLength);
        const days = Math.abs(diffDays(only.date, b.date));
        if (days <= maxDays) {
          this.push(
            this.pair('identifier', 'ID_VALOR', this.rules.autoConfirm.byIdentifier ? 'auto' : 'suggest', b, only, {
              dateScale: maxDays,
              competitors: 1,
              explanation: `Mesmo identificador (${identifier}) e mesmo valor; correspondência única.`,
            }),
          );
        } else {
          this.push(
            this.pair('identifier', 'ID_VALOR_DATA_FORA', 'suggest', b, only, {
              dateScale: maxDays,
              competitors: 1,
              divergence: 'date',
              explanation: `Mesmo identificador (${identifier}) e mesmo valor, mas datas com ${days} dias de diferença (limite de ${maxDays}).`,
            }),
          );
        }
        continue;
      }

      if (exactCandidates.length >= 1) {
        const proposals = exactCandidates
          .map((l) => {
            const competitors = Math.max(exactCandidates.length, (exactReverse.get(l.id) ?? []).length);
            return this.pair('identifier', 'ID_VALOR', 'suggest', b, l, {
              dateScale: maxDays,
              competitors,
              ambiguous: true,
              explanation: `Mesmo identificador (${sharedIdentifier(b, l, minIdentifierLength)}) e mesmo valor em ${competitors} candidatos; exige revisão.`,
            });
          })
          .sort((x, y) => this.byConfidence(x, y))
          .slice(0, this.rules.suggestions.maxPerItem);
        for (const proposal of proposals) this.push(proposal);
        continue;
      }

      const candidates = edges.get(b.id) ?? [];
      const single = candidates[0];
      if (candidates.length === 1 && single && (reverse.get(single.id) ?? []).length === 1) {
        const difference = Math.abs(b.amountCents - single.amountCents);
        this.push(
          this.pair('identifier', 'ID_VALOR_DIVERGENTE', 'suggest', b, single, {
            dateScale: maxDays,
            competitors: 1,
            divergence: 'amount',
            explanation: `Mesmo identificador (${sharedIdentifier(b, single, minIdentifierLength)}) com valores diferentes (diferença de ${formatBRL(difference)}).`,
          }),
        );
      }
    }
  }

  // -- fase 2: valor exato e data na tolerância ----------------------------

  private phaseAmountDate(): void {
    const tolerance = this.rules.dateToleranceDays;
    const byAmount = new Map<number, ReconItem[]>();
    for (const l of this.ledger) {
      if (this.used.has(l.id)) continue;
      const list = byAmount.get(l.amountCents);
      if (list) list.push(l);
      else byAmount.set(l.amountCents, [l]);
    }

    const edges = new Map<string, ReconItem[]>();
    const reverse = new Map<string, ReconItem[]>();
    for (const b of this.bank) {
      if (this.used.has(b.id)) continue;
      for (const l of byAmount.get(b.amountCents) ?? []) {
        if (Math.abs(diffDays(l.date, b.date)) > tolerance || this.isRejected([b.id], [l.id])) continue;
        const forward = edges.get(b.id);
        if (forward) forward.push(l);
        else edges.set(b.id, [l]);
        const backward = reverse.get(l.id);
        if (backward) backward.push(b);
        else reverse.set(l.id, [b]);
      }
    }

    // A unicidade é avaliada sobre o grafo completo da fase, antes de qualquer decisão.
    const unique: Array<[ReconItem, ReconItem]> = [];
    const ambiguous: ReconItem[] = [];
    for (const b of this.bank) {
      const candidates = edges.get(b.id);
      if (!candidates || !this.free(b)) continue;
      const only = candidates[0];
      if (candidates.length === 1 && only && (reverse.get(only.id) ?? []).length === 1 && this.free(only)) {
        unique.push([b, only]);
      } else {
        ambiguous.push(b);
      }
    }

    for (const [b, l] of unique) {
      const days = Math.abs(diffDays(l.date, b.date));
      const corroborated = days === 0 && this.similarity(b, l) >= DESCRIPTION_MATCH_THRESHOLD;
      const ruleCode: RuleCode = corroborated ? 'VALOR_DATA_REFERENCIA' : 'VALOR_DATA_UNICO';
      const enabled = corroborated
        ? this.rules.autoConfirm.byAmountDateReference
        : this.rules.autoConfirm.byUniqueAmountDate;
      this.push(
        this.pair('amount_date', ruleCode, enabled ? 'auto' : 'suggest', b, l, {
          dateScale: tolerance,
          competitors: 1,
          explanation: corroborated
            ? 'Mesmo valor e mesma data, com descrição coincidente; candidato único.'
            : `Mesmo valor, datas com ${days} dia(s) de diferença; candidato único dentro da tolerância.`,
        }),
      );
    }

    for (const b of ambiguous) {
      const candidates = edges.get(b.id) ?? [];
      const proposals = candidates
        .map((l) => {
          const competitors = Math.max(candidates.length, (reverse.get(l.id) ?? []).length);
          return this.pair('amount_date', 'VALOR_DATA_AMBIGUO', 'suggest', b, l, {
            dateScale: tolerance,
            competitors,
            ambiguous: true,
            explanation:
              competitors > 1
                ? `Mesmo valor dentro da tolerância de data, com ${competitors} candidatos possíveis; exige revisão.`
                : 'Mesmo valor dentro da tolerância de data, mas um dos itens já tem outra sugestão pendente; exige revisão.',
          });
        })
        .sort((x, y) => this.byConfidence(x, y))
        .slice(0, this.rules.suggestions.maxPerItem);
      for (const proposal of proposals) this.push(proposal);
    }
  }

  // -- fase 3: valor dentro da tolerância ----------------------------------

  private phaseTolerance(): void {
    if (this.rules.amountToleranceCents === 0 && this.rules.amountTolerancePercent === 0) return;
    const dateTolerance = this.rules.dateToleranceDays;
    for (const b of this.bank) {
      if (!this.free(b)) continue;
      const limit = this.amountTolerance(b.amountCents);
      if (limit === 0) continue;
      const candidates = this.ledger.filter((l) => {
        const difference = Math.abs(b.amountCents - l.amountCents);
        return (
          this.free(l) &&
          sameSign(b.amountCents, l.amountCents) &&
          difference > 0 &&
          difference <= limit &&
          Math.abs(diffDays(l.date, b.date)) <= dateTolerance &&
          !this.isRejected([b.id], [l.id])
        );
      });
      const proposals = candidates
        .map((l) =>
          this.pair('tolerance', 'TOLERANCIA_VALOR', 'suggest', b, l, {
            dateScale: dateTolerance,
            competitors: candidates.length,
            divergence: 'amount',
            ambiguous: candidates.length > 1,
            explanation: `Valores com diferença de ${formatBRL(Math.abs(b.amountCents - l.amountCents))}, dentro da tolerância configurada.`,
          }),
        )
        .sort((x, y) => this.byConfidence(x, y))
        .slice(0, this.rules.suggestions.maxPerItem);
      for (const proposal of proposals) this.push(proposal);
    }
  }

  // -- fase 4: agrupamento N:1 e 1:N ---------------------------------------

  private findSubsets(target: number, candidates: ReconItem[]): ReconItem[][] {
    const { maxGroupSize } = this.rules.grouping;
    const goal = Math.abs(target);
    const pool = [...candidates].sort(
      (a, b) => Math.abs(b.amountCents) - Math.abs(a.amountCents) || byDateThenId(a, b),
    );
    const solutions: ReconItem[][] = [];
    const chosen: ReconItem[] = [];
    const search = (start: number, sum: number) => {
      if (solutions.length >= GROUP_SOLUTION_LIMIT) return;
      if (sum === goal && chosen.length >= 2) {
        solutions.push([...chosen]);
        return;
      }
      if (chosen.length >= maxGroupSize) return;
      for (let i = start; i < pool.length; i += 1) {
        const candidate = pool[i] as ReconItem;
        const next = sum + Math.abs(candidate.amountCents);
        if (next > goal) continue;
        chosen.push(candidate);
        search(i + 1, next);
        chosen.pop();
        if (solutions.length >= GROUP_SOLUTION_LIMIT) return;
      }
    };
    search(0, 0);
    return solutions;
  }

  private groupFor(anchor: ReconItem, others: readonly ReconItem[]): void {
    const tolerance = this.rules.dateToleranceDays;
    const candidates = others
      .filter(
        (other) =>
          this.free(other) &&
          sameSign(anchor.amountCents, other.amountCents) &&
          Math.abs(other.amountCents) < Math.abs(anchor.amountCents) &&
          Math.abs(diffDays(other.date, anchor.date)) <= tolerance,
      )
      .sort(
        (a, b) =>
          Math.abs(diffDays(a.date, anchor.date)) - Math.abs(diffDays(b.date, anchor.date)) || byDateThenId(a, b),
      )
      .slice(0, this.rules.grouping.maxCandidates);
    if (candidates.length < 2) return;

    const solutions = this.findSubsets(anchor.amountCents, candidates).filter((parts) => {
      const ids = parts.map((part) => part.id);
      return anchor.side === 'bank' ? !this.isRejected([anchor.id], ids) : !this.isRejected(ids, [anchor.id]);
    });
    if (solutions.length === 0) return;

    const ambiguous = solutions.length > 1;
    const proposals = solutions.slice(0, 2).map((parts): ProposedMatch => {
      const ids = parts.map((part) => part.id).sort();
      const maxDays = Math.max(...parts.map((part) => Math.abs(diffDays(part.date, anchor.date))));
      const identifier = parts.every((part) =>
        sharedIdentifier(anchor, part, this.rules.minIdentifierLength),
      )
        ? 1
        : 0;
      const description = round4(
        parts.reduce((total, part) => total + this.similarity(anchor, part), 0) / parts.length,
      );
      const breakdown: ScoreBreakdown = {
        amount: 1,
        date: round4(Math.max(0, 1 - maxDays / (tolerance + 1))),
        identifier,
        description,
        competitors: solutions.length,
      };
      // Agrupamento é evidência mais fraca que par direto: teto de 0,9.
      const confidence = round4(Math.min(0.9, (ambiguous ? 0.45 : 0.7) + 0.15 * identifier + 0.05 * description));
      return {
        type: 'group',
        decision: 'suggest',
        ruleCode: 'AGRUPAMENTO',
        bankIds: anchor.side === 'bank' ? [anchor.id] : ids,
        ledgerIds: anchor.side === 'bank' ? ids : [anchor.id],
        confidence,
        breakdown,
        differenceCents: 0,
        dateDiffDays: maxDays,
        divergence: null,
        ambiguous,
        categoryId: null,
        explanation: `Soma de ${parts.length} itens igual ao valor do outro lado.${ambiguous ? ' Há mais de uma combinação possível.' : ''}`,
      };
    });
    for (const proposal of proposals) this.push(proposal);
  }

  private phaseGrouping(): void {
    if (!this.rules.grouping.enabled) return;
    for (const b of this.bank) if (this.free(b)) this.groupFor(b, this.ledger);
    for (const l of this.ledger) if (this.free(l)) this.groupFor(l, this.bank);
  }

  // -- fase 5: transferências internas -------------------------------------

  private phaseTransfers(): void {
    if (!this.rules.transfers.enabled) return;
    const tolerance = this.rules.transfers.dateToleranceDays;
    const primary = new Set(this.bank.map((item) => item.id));
    const all = [...this.bank, ...this.otherBank].filter((item) => this.free(item)).sort(byDateThenId);
    const debits = all.filter((item) => item.amountCents < 0);
    const credits = all.filter((item) => item.amountCents > 0);

    const edges = new Map<string, ReconItem[]>();
    const reverse = new Map<string, ReconItem[]>();
    for (const debit of debits) {
      for (const credit of credits) {
        if (
          debit.accountId === credit.accountId ||
          debit.accountId === null ||
          credit.accountId === null ||
          -debit.amountCents !== credit.amountCents ||
          Math.abs(diffDays(debit.date, credit.date)) > tolerance ||
          (!primary.has(debit.id) && !primary.has(credit.id)) ||
          (debit.kind !== 'internal_transfer' && credit.kind !== 'internal_transfer') ||
          this.isRejected([debit.id, credit.id], [])
        ) {
          continue;
        }
        const forward = edges.get(debit.id);
        if (forward) forward.push(credit);
        else edges.set(debit.id, [credit]);
        const backward = reverse.get(credit.id);
        if (backward) backward.push(debit);
        else reverse.set(credit.id, [debit]);
      }
    }

    const proposals: ProposedMatch[] = [];
    for (const debit of debits) {
      const candidates = edges.get(debit.id) ?? [];
      for (const credit of candidates.slice(0, this.rules.suggestions.maxPerItem)) {
        const competitors = Math.max(candidates.length, (reverse.get(credit.id) ?? []).length);
        const unique = competitors === 1;
        const strong = debit.kind === 'internal_transfer' && credit.kind === 'internal_transfer';
        const days = Math.abs(diffDays(debit.date, credit.date));
        const breakdown: ScoreBreakdown = {
          amount: 1,
          date: round4(Math.max(0, 1 - days / (tolerance + 1))),
          identifier: sharedIdentifier(debit, credit, this.rules.minIdentifierLength) ? 1 : 0,
          description: round4(this.similarity(debit, credit)),
          competitors,
        };
        proposals.push({
          type: 'internal_transfer',
          decision: unique && strong && this.rules.autoConfirm.internalTransfers ? 'auto' : 'suggest',
          ruleCode: 'TRANSFERENCIA_INTERNA',
          bankIds: [debit.id, credit.id].sort(),
          ledgerIds: [],
          confidence: round4(unique ? (strong ? 0.9 : 0.7) : 0.5 / competitors + 0.25),
          breakdown,
          differenceCents: 0,
          dateDiffDays: days,
          divergence: null,
          ambiguous: !unique,
          categoryId: null,
          explanation: unique
            ? 'Débito e crédito de mesmo valor em contas diferentes da empresa.'
            : `Débito e crédito de mesmo valor em contas diferentes, com ${competitors} pares possíveis; exige revisão.`,
        });
      }
    }
    for (const proposal of proposals) this.push(proposal);
  }

  // -- fase 6: estornos ----------------------------------------------------

  private phaseReversals(): void {
    if (!this.rules.reversals.enabled) return;
    const window = this.rules.reversals.windowDays;
    const reversals = this.bank.filter((item) => item.kind === 'reversal' && this.free(item));
    const edges = new Map<string, ReconItem[]>();
    const reverse = new Map<string, ReconItem[]>();
    for (const reversal of reversals) {
      for (const original of this.bank) {
        const days = diffDays(original.date, reversal.date);
        if (
          original.id === reversal.id ||
          original.kind === 'reversal' ||
          !this.free(original) ||
          original.accountId !== reversal.accountId ||
          original.amountCents !== -reversal.amountCents ||
          days < 0 ||
          days > window ||
          this.isRejected([original.id, reversal.id], [])
        ) {
          continue;
        }
        const forward = edges.get(reversal.id);
        if (forward) forward.push(original);
        else edges.set(reversal.id, [original]);
        const backward = reverse.get(original.id);
        if (backward) backward.push(reversal);
        else reverse.set(original.id, [reversal]);
      }
    }

    const proposals: ProposedMatch[] = [];
    for (const reversal of reversals) {
      const candidates = [...(edges.get(reversal.id) ?? [])].sort((a, b) => byDateThenId(b, a));
      for (const original of candidates.slice(0, this.rules.suggestions.maxPerItem)) {
        const competitors = Math.max(candidates.length, (reverse.get(original.id) ?? []).length);
        const unique = competitors === 1;
        const days = diffDays(original.date, reversal.date);
        const description = round4(this.similarity(original, reversal));
        const breakdown: ScoreBreakdown = {
          amount: 1,
          date: round4(Math.max(0, 1 - days / (window + 1))),
          identifier: sharedIdentifier(original, reversal, this.rules.minIdentifierLength) ? 1 : 0,
          description,
          competitors,
        };
        const corroborated = breakdown.identifier === 1 || description >= DESCRIPTION_MATCH_THRESHOLD;
        proposals.push({
          type: 'reversal',
          decision: 'suggest',
          ruleCode: 'ESTORNO',
          bankIds: [original.id, reversal.id].sort(),
          ledgerIds: [],
          confidence: round4(unique ? (corroborated ? 0.95 : 0.85) : 0.5 / competitors + 0.25),
          breakdown,
          differenceCents: 0,
          dateDiffDays: days,
          divergence: null,
          ambiguous: !unique,
          categoryId: null,
          explanation: `Estorno de mesmo valor ${days} dia(s) após a transação original.${unique ? '' : ' Há mais de uma transação original possível.'}`,
        });
      }
    }
    for (const proposal of proposals) this.push(proposal);
  }

  // -- fase 7: tarifas, impostos e encargos sem lançamento -----------------

  private phaseClassification(): void {
    for (const b of this.bank) {
      if (!this.free(b) || (b.kind !== 'fee' && b.kind !== 'tax' && b.kind !== 'interest')) continue;
      if (this.isRejected([b.id], [])) continue;
      this.push({
        type: 'classification',
        decision: this.rules.autoConfirm.fees ? 'auto' : 'suggest',
        ruleCode: 'CLASSIFICACAO_REGRA',
        bankIds: [b.id],
        ledgerIds: [],
        confidence: 0.9,
        breakdown: { amount: 1, date: 1, identifier: 0, description: 1, competitors: 1 },
        differenceCents: 0,
        dateDiffDays: 0,
        divergence: null,
        ambiguous: false,
        categoryId: b.categoryId ?? null,
        explanation: `${ITEM_KIND_LABELS[b.kind]} identificada por regra de classificação, sem lançamento correspondente.`,
      });
    }
  }

  run(): void {
    this.phaseIdentifier();
    this.phaseAmountDate();
    this.phaseTolerance();
    this.phaseGrouping();
    this.phaseTransfers();
    this.phaseReversals();
    this.phaseClassification();
  }
}

/**
 * Executa a conciliação. Função pura: as mesmas entradas e regras produzem sempre a mesma saída,
 * em qualquer ordem de entrada.
 */
export function reconcile(input: ReconInput): ReconOutput {
  const bank = [...input.bank].sort(byDateThenId);
  const ledger = [...input.ledger].sort(byDateThenId);
  const otherBank = [...(input.otherAccountsBank ?? [])].sort(byDateThenId);

  const engine = new Engine(bank, ledger, otherBank, input);
  engine.run();

  const byRule: ReconOutput['stats']['byRule'] = {};
  let autoMatched = 0;
  let suggested = 0;
  let divergences = 0;
  for (const match of engine.matches) {
    byRule[match.ruleCode] = (byRule[match.ruleCode] ?? 0) + 1;
    if (match.decision === 'auto') autoMatched += 1;
    else suggested += 1;
    if (match.divergence) divergences += 1;
  }

  return {
    engineVersion: ENGINE_VERSION,
    matches: engine.matches,
    stats: { bankItems: bank.length, ledgerItems: ledger.length, autoMatched, suggested, divergences, byRule },
  };
}
