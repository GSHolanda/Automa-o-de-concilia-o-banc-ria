import { useQueryClient } from '@tanstack/react-query';
import type { ApprovalSettings } from '@concilia/core/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth';
import { Checkbox } from '../../components/Checkbox';
import { PageHeader } from '../../components/PageHeader';
import { LockedFieldset, SETTINGS_KEY, SettingsGate, SettingsSaveBar, SettingsSection, useCanWrite, useSettings } from './settings';

const OPERATIONS: Array<{ key: keyof ApprovalSettings['requireFor']; label: string; hint: string }> = [
  { key: 'manual', label: 'Conciliação manual', hint: 'Quando alguém liga manualmente um item do extrato a um lançamento.' },
  { key: 'divergent', label: 'Conciliação com diferença de valor', hint: 'Quando os valores não batem e a pessoa decide aceitar a diferença.' },
  { key: 'ambiguous', label: 'Itens com mais de uma possibilidade', hint: 'Quando havia vários candidatos igualmente prováveis e um foi escolhido.' },
  { key: 'grouped', label: 'Conciliação em grupo', hint: 'Quando um item é ligado à soma de vários lançamentos.' },
  { key: 'classification', label: 'Classificação de itens', hint: 'Quando um item sem lançamento (tarifa, juros) é classificado em uma categoria.' },
  { key: 'ignore', label: 'Ignorar itens', hint: 'Quando alguém decide que um item não precisa ser conciliado.' },
];

export function AprovacoesPage() {
  const settings = useSettings();
  return (
    <>
      <PageHeader title="Aprovações" subtitle="Exige uma segunda pessoa para validar decisões de conciliação sensíveis." />
      <SettingsGate query={settings}>{(data) => <AprovacoesForm key={data.version} version={data.version} approvals={data.settings.approvals} />}</SettingsGate>
    </>
  );
}

function AprovacoesForm({ version, approvals }: { version: number; approvals: ApprovalSettings }) {
  const { hasModule, can } = useAuth();
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();
  const moduleActive = hasModule('approvals');
  const [f, setF] = useState<ApprovalSettings>(() => ({ ...approvals, requireFor: { ...approvals.requireFor } }));
  const locked = !canWrite || !moduleActive;

  return (
    <div className="pilha">
      {!moduleActive && (
        <div className="faixa-aviso" role="status" style={{ borderRadius: 'var(--raio)', border: '1px solid #f0d9a3' }}>
          O módulo de aprovações não está ativo para a empresa, então estas opções ficam desabilitadas.{' '}
          {can('modules.manage') ? <Link to="/configuracoes/modulos">Abrir Módulos</Link> : 'Peça a quem administra os módulos para ativá-lo.'}
        </div>
      )}
      <LockedFieldset locked={locked}>
        <SettingsSection title="Aprovação em duas etapas">
          <Checkbox label="Exigir aprovação em duas etapas" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })}
            hint="As decisões marcadas abaixo ficam aguardando aprovação de outra pessoa antes de valerem; só então os itens passam a conciliados." />
          <Checkbox label="Quem propõe não aprova" checked={f.fourEyes} onChange={(e) => setF({ ...f, fourEyes: e.target.checked })}
            hint="Impede que a mesma pessoa proponha e aprove a própria decisão. Recomendado: sem isso a aprovação perde o efeito de controle." />
        </SettingsSection>
        <SettingsSection title="Operações que exigem aprovação" description="Vale somente com a aprovação em duas etapas ativada.">
          {OPERATIONS.map((op) => (
            <Checkbox key={op.key} label={op.label} hint={op.hint} disabled={!f.enabled} checked={f.requireFor[op.key]}
              onChange={(e) => setF({ ...f, requireFor: { ...f.requireFor, [op.key]: e.target.checked } })} />
          ))}
        </SettingsSection>
      </LockedFieldset>
      <SettingsSaveBar
        version={version}
        invalid={false}
        disabled={locked}
        buildPatch={() => ({ approvals: f })}
        onReload={() => void queryClient.invalidateQueries({ queryKey: SETTINGS_KEY })}
      />
    </div>
  );
}
