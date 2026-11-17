import type { ReconRules } from '@concilia/core/shared';
import { useState } from 'react';
import { Checkbox } from '../../components/Checkbox';
import { PageHeader } from '../../components/PageHeader';
import { NumberField, rangeError } from './NumberField';
import { FIELD_GRID, LockedFieldset, SettingsGate, SettingsSaveBar, SettingsSection, useCanWrite, useSettings } from './settings';
import { useQueryClient } from '@tanstack/react-query';
import { SETTINGS_KEY } from './settings';

/** Formulário em unidades de tela: reais e percentual (0 a 100). */
interface Form {
  dateToleranceDays: number;
  identifierMaxDateDiffDays: number;
  amountToleranceReais: number;
  amountTolerancePercent: number;
  minIdentifierLength: number;
  autoConfirm: ReconRules['autoConfirm'];
  minConfidencePct: number;
  maxPerItem: number;
  grouping: ReconRules['grouping'];
  transfers: ReconRules['transfers'];
  reversals: ReconRules['reversals'];
}

const toForm = (r: ReconRules): Form => ({
  dateToleranceDays: r.dateToleranceDays,
  identifierMaxDateDiffDays: r.identifierMaxDateDiffDays,
  amountToleranceReais: r.amountToleranceCents / 100,
  amountTolerancePercent: r.amountTolerancePercent,
  minIdentifierLength: r.minIdentifierLength,
  autoConfirm: { ...r.autoConfirm },
  minConfidencePct: Math.round(r.suggestions.minConfidence * 100),
  maxPerItem: r.suggestions.maxPerItem,
  grouping: { ...r.grouping },
  transfers: { ...r.transfers },
  reversals: { ...r.reversals },
});

const toRules = (f: Form): ReconRules => ({
  dateToleranceDays: f.dateToleranceDays,
  identifierMaxDateDiffDays: f.identifierMaxDateDiffDays,
  amountToleranceCents: Math.round(f.amountToleranceReais * 100),
  amountTolerancePercent: f.amountTolerancePercent,
  minIdentifierLength: f.minIdentifierLength,
  autoConfirm: f.autoConfirm,
  suggestions: { minConfidence: Number((f.minConfidencePct / 100).toFixed(4)), maxPerItem: f.maxPerItem },
  grouping: f.grouping,
  transfers: f.transfers,
  reversals: f.reversals,
});

function errorsOf(f: Form) {
  return {
    dateToleranceDays: rangeError(f.dateToleranceDays, 0, 30),
    identifierMaxDateDiffDays: rangeError(f.identifierMaxDateDiffDays, 0, 120),
    amountToleranceReais:
      rangeError(f.amountToleranceReais, 0, 10000, false) ??
      (Math.abs(f.amountToleranceReais * 100 - Math.round(f.amountToleranceReais * 100)) > 1e-6 ? 'Use no máximo duas casas decimais.' : null),
    amountTolerancePercent: rangeError(f.amountTolerancePercent, 0, 10, false),
    minIdentifierLength: rangeError(f.minIdentifierLength, 3, 20),
    minConfidencePct: rangeError(f.minConfidencePct, 0, 100, false),
    maxPerItem: rangeError(f.maxPerItem, 1, 10),
    maxGroupSize: rangeError(f.grouping.maxGroupSize, 2, 6),
    maxCandidates: rangeError(f.grouping.maxCandidates, 2, 16),
    transferDays: rangeError(f.transfers.dateToleranceDays, 0, 10),
    reversalDays: rangeError(f.reversals.windowDays, 0, 180),
  };
}

export function RegrasPage() {
  const settings = useSettings();
  return (
    <>
      <PageHeader title="Regras e tolerâncias" subtitle="Definem como o sistema procura, sugere e confirma correspondências entre extrato e lançamentos." />
      <SettingsGate query={settings}>{(data) => <RegrasForm key={data.version} version={data.version} rules={data.settings.reconciliation} />}</SettingsGate>
    </>
  );
}

function RegrasForm({ version, rules }: { version: number; rules: ReconRules }) {
  const canWrite = useCanWrite();
  const queryClient = useQueryClient();
  const [f, setF] = useState<Form>(() => toForm(rules));
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setF((prev) => ({ ...prev, [key]: value }));
  const errors = errorsOf(f);
  const invalid = Object.values(errors).some((e) => e !== null);

  return (
    <div className="pilha">
      <LockedFieldset locked={!canWrite}>
        <SettingsSection title="Tolerâncias" description="Até onde duas informações podem diferir e ainda ser tratadas como a mesma operação.">
          <div style={FIELD_GRID}>
            <NumberField label="Tolerância de data" suffix="dias" value={f.dateToleranceDays} onChange={(v) => set('dateToleranceDays', v)} error={errors.dateToleranceDays}
              hint="Quantos dias o extrato e o lançamento podem estar afastados quando a correspondência é por valor e data. Ex.: 2 aceita um pagamento lançado na sexta e compensado na segunda." />
            <NumberField label="Limite de dias para identificador" suffix="dias" value={f.identifierMaxDateDiffDays} onChange={(v) => set('identifierMaxDateDiffDays', v)} error={errors.identifierMaxDateDiffDays}
              hint="Afastamento máximo de datas quando o identificador (ex.: número do documento) e o valor conferem. Costuma ser maior, pois o identificador já dá segurança." />
            <NumberField label="Tolerância de valor" suffix="R$" decimals={2} value={f.amountToleranceReais} onChange={(v) => set('amountToleranceReais', v)} error={errors.amountToleranceReais}
              hint="Diferença em reais aceita para sugerir uma correspondência (ex.: tarifa descontada do valor). Nunca concilia sozinho: a pessoa decide." />
            <NumberField label="Tolerância de valor percentual" suffix="%" value={f.amountTolerancePercent} onChange={(v) => set('amountTolerancePercent', v)} error={errors.amountTolerancePercent}
              hint="Diferença proporcional aceita para sugerir correspondência, de 0 a 10%. Zero exige valores exatos." />
            <NumberField label="Tamanho mínimo de identificador" suffix="caracteres" value={f.minIdentifierLength} onChange={(v) => set('minIdentifierLength', v)} error={errors.minIdentifierLength}
              hint="Identificadores mais curtos que isto são ignorados, para não casar documentos diferentes que terminam em números parecidos (ex.: 'NF 12')." />
          </div>
        </SettingsSection>

        <SettingsSection title="Conciliação automática" description="Situações em que o sistema confirma sozinho. Só estas chaves decidem; a confiança das sugestões nunca concilia automaticamente.">
          <Checkbox label="Por identificador" checked={f.autoConfirm.byIdentifier} onChange={(e) => set('autoConfirm', { ...f.autoConfirm, byIdentifier: e.target.checked })}
            hint="Concilia quando o identificador (documento, ID da transação) e o valor são iguais e as datas estão dentro do limite." />
          <Checkbox label="Por valor, data e descrição" checked={f.autoConfirm.byAmountDateReference} onChange={(e) => set('autoConfirm', { ...f.autoConfirm, byAmountDateReference: e.target.checked })}
            hint="Concilia quando valor e data conferem e a descrição ou referência é igual ou muito parecida." />
          <Checkbox label="Por candidato único" checked={f.autoConfirm.byUniqueAmountDate} onChange={(e) => set('autoConfirm', { ...f.autoConfirm, byUniqueAmountDate: e.target.checked })}
            hint="Concilia quando só existe um lançamento com aquele valor e data. Fica mais arriscado se há muitos itens repetidos." />
          <Checkbox label="Transferências internas" checked={f.autoConfirm.internalTransfers} onChange={(e) => set('autoConfirm', { ...f.autoConfirm, internalTransfers: e.target.checked })}
            hint="Concilia sozinho a saída de uma conta e a entrada correspondente em outra conta da empresa." />
          <Checkbox label="Tarifas" checked={f.autoConfirm.fees} onChange={(e) => set('autoConfirm', { ...f.autoConfirm, fees: e.target.checked })}
            hint="Classifica e concilia sozinho tarifas bancárias reconhecidas, sem lançamento correspondente." />
        </SettingsSection>

        <SettingsSection title="Sugestões" description="Correspondências prováveis mostradas para a pessoa aceitar ou rejeitar.">
          <div style={FIELD_GRID}>
            <NumberField label="Confiança mínima" suffix="%" value={f.minConfidencePct} onChange={(v) => set('minConfidencePct', v)} error={errors.minConfidencePct}
              hint="Sugestões abaixo deste percentual não aparecem. Valores altos mostram menos sugestões, porém mais certeiras." />
            <NumberField label="Máximo de sugestões por item" value={f.maxPerItem} onChange={(v) => set('maxPerItem', v)} error={errors.maxPerItem}
              hint="Quantas opções mostrar para cada item pendente, de 1 a 10." />
          </div>
        </SettingsSection>

        <SettingsSection title="Agrupamento" description="Um item do extrato que corresponde à soma de vários lançamentos (ou o contrário).">
          <Checkbox label="Sugerir agrupamentos" checked={f.grouping.enabled} onChange={(e) => set('grouping', { ...f.grouping, enabled: e.target.checked })}
            hint="Procura combinações de lançamentos cuja soma bate com o valor do extrato, por exemplo um depósito que reúne vários recebimentos." />
          <div style={FIELD_GRID}>
            <NumberField label="Máximo de itens por grupo" value={f.grouping.maxGroupSize} onChange={(v) => set('grouping', { ...f.grouping, maxGroupSize: v })} error={errors.maxGroupSize}
              hint="Grupos maiores demoram mais e aumentam o risco de combinações coincidentes. De 2 a 6." />
            <NumberField label="Máximo de candidatos analisados" value={f.grouping.maxCandidates} onChange={(v) => set('grouping', { ...f.grouping, maxCandidates: v })} error={errors.maxCandidates}
              hint="Quantos lançamentos próximos entram na busca. De 2 a 16." />
          </div>
        </SettingsSection>

        <SettingsSection title="Transferências" description="Movimentos entre contas da própria empresa.">
          <Checkbox label="Detectar transferências entre contas" checked={f.transfers.enabled} onChange={(e) => set('transfers', { ...f.transfers, enabled: e.target.checked })}
            hint="Liga a saída de uma conta ao crédito de mesmo valor em outra, evitando tratá-los como receita e despesa." />
          <div style={FIELD_GRID}>
            <NumberField label="Tolerância de data da transferência" suffix="dias" value={f.transfers.dateToleranceDays} onChange={(v) => set('transfers', { ...f.transfers, dateToleranceDays: v })} error={errors.transferDays}
              hint="Dias de diferença aceitos entre a saída e a entrada. De 0 a 10." />
          </div>
        </SettingsSection>

        <SettingsSection title="Estornos" description="Operações desfeitas pelo banco ou pela empresa.">
          <Checkbox label="Detectar estornos" checked={f.reversals.enabled} onChange={(e) => set('reversals', { ...f.reversals, enabled: e.target.checked })}
            hint="Identifica um movimento e o seu estorno de sinal oposto para que não fiquem pendentes." />
          <div style={FIELD_GRID}>
            <NumberField label="Janela de estorno" suffix="dias" value={f.reversals.windowDays} onChange={(v) => set('reversals', { ...f.reversals, windowDays: v })} error={errors.reversalDays}
              hint="Prazo máximo entre o movimento original e o estorno. De 0 a 180." />
          </div>
        </SettingsSection>
      </LockedFieldset>

      <SettingsSaveBar
        version={version}
        invalid={invalid}
        disabled={!canWrite}
        buildPatch={() => ({ reconciliation: toRules(f) })}
        onReload={() => void queryClient.invalidateQueries({ queryKey: SETTINGS_KEY })}
      />
    </div>
  );
}
