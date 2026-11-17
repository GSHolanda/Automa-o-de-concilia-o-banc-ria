import { useQueryClient } from '@tanstack/react-query';
import type { TenantSettings } from '@concilia/core/shared';
import { useState } from 'react';
import { Checkbox } from '../../components/Checkbox';
import { PageHeader } from '../../components/PageHeader';
import { NumberField, rangeError } from './NumberField';
import { FIELD_GRID, LockedFieldset, SETTINGS_KEY, SettingsGate, SettingsSaveBar, SettingsSection, useCanWrite, useSettings } from './settings';

export function SegurancaPage() {
  const settings = useSettings();
  return (
    <>
      <PageHeader title="Segurança" subtitle="Sessão, senhas e guarda dos arquivos importados." />
      <SettingsGate query={settings}>{(data) => <SegurancaForm key={data.version} version={data.version} settings={data.settings} />}</SettingsGate>
    </>
  );
}

function SegurancaForm({ version, settings }: { version: number; settings: TenantSettings }) {
  const canWrite = useCanWrite();
  const queryClient = useQueryClient();
  const [idle, setIdle] = useState(settings.security.sessionIdleMinutes);
  const [minLen, setMinLen] = useState(settings.security.passwordMinLength);
  const keepForever = settings.imports.originalFileRetentionDays === null;
  const [forever, setForever] = useState(keepForever);
  const [days, setDays] = useState(settings.imports.originalFileRetentionDays ?? 365);

  const errors = [rangeError(idle, 5, 1440), rangeError(minLen, 8, 64), forever ? null : rangeError(days, 30, 3650)];
  const invalid = errors.some((e) => e !== null);

  return (
    <div className="pilha">
      <LockedFieldset locked={!canWrite}>
        <SettingsSection title="Sessão e senhas">
          <div style={FIELD_GRID}>
            <NumberField label="Inatividade da sessão" suffix="minutos" value={idle} onChange={setIdle} error={errors[0]}
              hint="Depois deste tempo sem uso a pessoa precisa entrar de novo. Tempos menores protegem melhor um computador deixado aberto. De 5 a 1440 (24 horas)." />
            <NumberField label="Tamanho mínimo da senha" suffix="caracteres" value={minLen} onChange={setMinLen} error={errors[1]}
              hint="Vale para senhas novas e trocas de senha; senhas atuais continuam funcionando até serem trocadas. De 8 a 64." />
          </div>
        </SettingsSection>
        <SettingsSection title="Arquivos importados" description="O arquivo original de cada importação fica guardado para conferência e reprocessamento.">
          <Checkbox label="Manter arquivos originais indefinidamente" checked={forever} onChange={(e) => setForever(e.target.checked)}
            hint="Desmarque para apagar o arquivo após um prazo. Os dados já importados e a trilha de auditoria não são apagados." />
          {!forever && (
            <div style={FIELD_GRID}>
              <NumberField label="Prazo de retenção" suffix="dias" value={days} onChange={setDays} error={errors[2]}
                hint="Após este prazo o arquivo original deixa de estar disponível, e reprocessar o lote não será mais possível. De 30 a 3650." />
            </div>
          )}
        </SettingsSection>
      </LockedFieldset>
      <SettingsSaveBar
        version={version}
        invalid={invalid}
        disabled={!canWrite}
        buildPatch={() => ({
          security: { sessionIdleMinutes: idle, passwordMinLength: minLen },
          imports: { originalFileRetentionDays: forever ? null : days },
        })}
        onReload={() => void queryClient.invalidateQueries({ queryKey: SETTINGS_KEY })}
      />
    </div>
  );
}
