import { useQuery } from '@tanstack/react-query';
import type { ImportProfileConfig } from '@concilia/core/shared';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError, errorMessage, type Page } from '../../api/client';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Checkbox } from '../../components/Checkbox';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Field } from '../../components/Field';
import { FileDrop } from '../../components/FileDrop';
import { Money } from '../../components/Money';
import { PageHeader } from '../../components/PageHeader';
import { Select } from '../../components/Select';
import { Spinner } from '../../components/Spinner';
import { useToast } from '../../components/Toast';
import {
  cleanImportMapping, defaultImportMapping, ImportMappingEditor, validateImportMapping,
} from '../perfis-importacao/ImportMappingEditor';
import { useWrite } from '../shared';
import {
  BatchStatusBadge, formatBytes, FORMAT_LABEL, IMPORTS_KEY, isRunning, SOURCE_LABEL,
  type FileFormat, type ImportBatch, type SourceKind,
} from './comum';

interface Account { id: string; name: string; active: boolean; accountNumber?: string | null }
interface Profile { id: string; name: string; sourceKind: SourceKind; fileFormat: 'csv' | 'xlsx'; active: boolean; config: ImportProfileConfig }

interface OfxPreview {
  account: { bankId?: string; branchId?: string; accountId?: string };
  period: { start: string | null; end: string | null };
  transactionCount: number;
  invalidCount: number;
  sample: { date: string; amountCents: number; description: string; type?: string }[];
  accountMatches: boolean;
}
interface Suggestion {
  headerRow: number;
  headers: string[];
  amountMode: ImportProfileConfig['amountMode'];
  columns: Partial<ImportProfileConfig['columns']>;
  missing: string[];
}
interface TabularPreview {
  sheetNames?: string[];
  sheetName?: string;
  headerRow: number;
  headers: string[];
  rowCount: number;
  sampleRows: (string | number | null)[][];
  suggestion: Suggestion;
}
interface UploadResult { id: string; fileFormat: FileFormat; fileName: string; preview: OfxPreview | TabularPreview }

function fromSuggestion(s: Suggestion, sheetName: string | null): ImportProfileConfig {
  const base = defaultImportMapping();
  return {
    ...base,
    sheetName,
    headerRow: s.headerRow,
    amountMode: s.amountMode,
    columns: { ...base.columns, ...s.columns, date: s.columns.date ?? '', description: s.columns.description?.length ? s.columns.description : [''] },
  };
}

function fromProfile(p: Profile, sheetName: string | null): ImportProfileConfig {
  const base = defaultImportMapping();
  return { ...base, ...p.config, sheetName: sheetName ?? p.config.sheetName ?? null, columns: { ...base.columns, ...p.config.columns } };
}

export function NovaImportacaoPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [sourceKind, setSourceKind] = useState<SourceKind>('bank');
  const [accountId, setAccountId] = useState('');
  const [profileId, setProfileId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [attempted, setAttempted] = useState(false);

  const [upload, setUpload] = useState<UploadResult | null>(null);
  const [duplicateOf, setDuplicateOf] = useState<string | null>(null);
  const [preview, setPreview] = useState<OfxPreview | TabularPreview | null>(null);
  const [mapping, setMapping] = useState<ImportProfileConfig>(defaultImportMapping());
  const [mappingTouched, setMappingTouched] = useState(false);
  const [allowMismatch, setAllowMismatch] = useState(false);
  const [saveProfile, setSaveProfile] = useState(false);
  const [profileName, setProfileName] = useState('');
  const [batchId, setBatchId] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [sheetLoading, setSheetLoading] = useState(false);

  const accounts = useQuery({ queryKey: ['bank-accounts', 'select'], queryFn: () => api.get<Page<Account>>('/bank-accounts') });
  const profiles = useQuery({ queryKey: ['import-profiles'], queryFn: () => api.get<Page<Profile>>('/import-profiles') });
  const profileList = (profiles.data?.items ?? []).filter((p) => p.active && p.sourceKind === sourceKind);
  const chosenProfile = profileList.find((p) => p.id === profileId) ?? null;

  const step: 1 | 2 | 3 = batchId ? 3 : upload ? 2 : 1;

  const send = useWrite<void, UploadResult>({
    inlineError: true,
    invalidate: [IMPORTS_KEY],
    mutationFn: () => {
      const form = new FormData();
      form.append('sourceKind', sourceKind);
      if (accountId) form.append('bankAccountId', accountId);
      if (profileId) form.append('profileId', profileId);
      form.append('file', file as File);
      return api.upload<UploadResult>('/imports', form);
    },
    onSuccess: (result) => {
      setDuplicateOf(null);
      setUpload(result);
      setPreview(result.preview);
      if (result.fileFormat !== 'ofx') {
        const p = result.preview as TabularPreview;
        setMapping(chosenProfile ? fromProfile(chosenProfile, p.sheetName ?? null) : fromSuggestion(p.suggestion, p.sheetName ?? null));
        setMappingTouched(false);
      }
    },
  });

  const cancel = useWrite({
    mutationFn: () => api.post(`/imports/${upload?.id}/cancel`),
    invalidate: [IMPORTS_KEY],
    success: 'Importação cancelada.',
    onSuccess: () => navigate('/importacoes'),
  });

  const mappingErrors = validateImportMapping(mapping);
  const mappingInvalid = upload?.fileFormat !== 'ofx' && Object.keys(mappingErrors).length > 0;
  const mismatch = upload?.fileFormat === 'ofx' && (preview as OfxPreview).accountMatches === false;
  const profileNameMissing = saveProfile && !profileName.trim();

  const confirm = useWrite<void, { id: string; jobId: string }>({
    inlineError: true,
    invalidate: [IMPORTS_KEY, ['import-profiles']],
    mutationFn: () =>
      api.post(`/imports/${upload?.id}/confirm`, {
        allowAccountMismatch: allowMismatch,
        ...(upload?.fileFormat !== 'ofx' ? { config: cleanImportMapping(mapping) } : {}),
        ...(upload?.fileFormat !== 'ofx' && saveProfile ? { saveProfileAs: profileName.trim() } : {}),
      }),
    onSuccess: (r) => setBatchId(r.id),
  });

  async function changeSheet(sheetName: string) {
    if (!upload) return;
    setSheetLoading(true);
    try {
      const r = await api.get<{ preview: TabularPreview }>(`/imports/${upload.id}/preview`, { sheetName });
      setPreview(r.preview);
      setMapping(chosenProfile ? fromProfile(chosenProfile, sheetName) : fromSuggestion(r.preview.suggestion, sheetName));
      setMappingTouched(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSheetLoading(false);
    }
  }

  const uploadError = send.error instanceof ApiError && send.error.code === 'duplicate_file';
  const existingId = uploadError ? ((send.error as ApiError).details as { batchId?: string } | undefined)?.batchId : undefined;

  const accountError = sourceKind === 'bank' && !accountId ? 'Selecione a conta bancária do extrato.' : null;
  const fileError = !file ? 'Selecione um arquivo.' : null;

  return (
    <>
      <PageHeader
        title="Nova importação"
        subtitle={`Passo ${step} de 3: ${['Arquivo', 'Pré-visualização e mapeamento', 'Processamento'][step - 1]}`}
        actions={<Link to="/importacoes">Voltar para importações</Link>}
      />

      {step === 1 && (
        <form
          className="cartao pilha"
          style={{ padding: 'var(--e5)', maxWidth: 720 }}
          onSubmit={(e) => {
            e.preventDefault();
            setAttempted(true);
            if (!accountError && !fileError) send.mutate();
          }}
        >
          <Select label="Origem" value={sourceKind}
            onChange={(e) => { setSourceKind(e.target.value as SourceKind); setProfileId(''); setFile(null); }}
            hint="Extrato: movimentos do banco (OFX, CSV ou XLSX). Lançamentos: registros da empresa (CSV ou XLSX)."
            options={[{ value: 'bank', label: SOURCE_LABEL.bank }, { value: 'ledger', label: SOURCE_LABEL.ledger }]} />
          <Select label={sourceKind === 'bank' ? 'Conta bancária' : 'Conta bancária (opcional)'} required={sourceKind === 'bank'}
            value={accountId} onChange={(e) => setAccountId(e.target.value)}
            placeholder={accounts.isLoading ? 'Carregando…' : 'Selecione'}
            error={attempted ? accountError : accounts.isError ? errorMessage(accounts.error) : null}
            options={(accounts.data?.items ?? []).filter((a) => a.active).map((a) => ({ value: a.id, label: a.name }))} />
          <Select label="Perfil de importação (opcional)" value={profileId} onChange={(e) => setProfileId(e.target.value)}
            placeholder="Nenhum: usar a sugestão do sistema"
            hint="Para CSV e XLSX. O perfil preenche o mapeamento de colunas; você poderá conferir e ajustar."
            error={profiles.isError ? errorMessage(profiles.error) : null}
            options={profileList.map((p) => ({ value: p.id, label: `${p.name} (${p.fileFormat.toUpperCase()})` }))} />
          <div>
            <FileDrop
              accept={sourceKind === 'bank' ? '.ofx,.csv,.xlsx' : '.csv,.xlsx'}
              label={file ? 'Trocar arquivo' : 'Selecionar arquivo'}
              hint={sourceKind === 'bank' ? 'Formatos: .ofx, .csv, .xlsx' : 'Formatos: .csv, .xlsx'}
              maxSizeMb={20}
              onFiles={(f) => setFile(f[0] ?? null)}
              onReject={(m) => toast.error(m)}
            />
            {file && <p style={{ marginTop: 'var(--e2)' }}><strong>{file.name}</strong> <span className="texto-suave">({formatBytes(file.size)})</span></p>}
            {attempted && fileError && <p className="erro-texto" role="alert">{fileError}</p>}
          </div>
          {send.errorText && (
            <div role="alert" className="erro-texto">
              {send.errorText}{' '}
              {existingId && <Link to={`/importacoes/${existingId}`}>Ver o lote existente</Link>}
            </div>
          )}
          <div className="linha" style={{ justifyContent: 'flex-end' }}>
            <Button type="submit" variant="primary" loading={send.isPending}>Enviar e pré-visualizar</Button>
          </div>
        </form>
      )}

      {step === 2 && upload && preview && (
        <div className="pilha" style={{ gap: 'var(--e5)' }}>
          <div className="cartao" style={{ padding: 'var(--e4)' }}>
            <strong>{upload.fileName}</strong>{' '}
            <Badge>{FORMAT_LABEL[upload.fileFormat] ?? upload.fileFormat}</Badge>
          </div>

          {upload.fileFormat === 'ofx' ? (
            <OfxView preview={preview as OfxPreview} mismatch={Boolean(mismatch)} allow={allowMismatch} onAllow={setAllowMismatch} />
          ) : (
            <>
              <TabularView preview={preview as TabularPreview} loading={sheetLoading} onSheet={(s) => void changeSheet(s)} />
              <div role="note" className="cartao" style={{ padding: 'var(--e4)', background: 'var(--cor-alerta-fundo)', color: 'var(--cor-alerta)' }}>
                {chosenProfile && !mappingTouched
                  ? `Mapeamento do perfil "${chosenProfile.name}". Confira se as colunas correspondem a este arquivo.`
                  : 'O mapeamento abaixo é uma sugestão heurística, feita a partir dos nomes das colunas. Confira cada campo antes de confirmar.'}
                {(preview as TabularPreview).suggestion.missing.length > 0 && !chosenProfile && (
                  <> Não foi possível identificar: {(preview as TabularPreview).suggestion.missing.join(', ')}.</>
                )}
              </div>
              <ImportMappingEditor
                value={mapping}
                onChange={(v) => { setMapping(v); setMappingTouched(true); }}
                headers={(preview as TabularPreview).headers}
                fileFormat={upload.fileFormat as 'csv' | 'xlsx'}
                errors={attempted ? mappingErrors : {}}
              />
              <div className="cartao pilha" style={{ padding: 'var(--e4)' }}>
                <Checkbox label="Salvar como perfil de importação" checked={saveProfile} onChange={(e) => setSaveProfile(e.target.checked)}
                  hint="Reaproveite este mapeamento nas próximas importações." />
                {saveProfile && (
                  <Field label="Nome do perfil" value={profileName} onChange={(e) => setProfileName(e.target.value)}
                    error={attempted && profileNameMissing ? 'Informe o nome do perfil.' : null} maxLength={120} />
                )}
              </div>
            </>
          )}

          {confirm.errorText && <p className="erro-texto" role="alert">{confirm.errorText}</p>}
          <div className="linha" style={{ justifyContent: 'flex-end' }}>
            <Button variant="danger" onClick={() => setConfirmCancel(true)} disabled={confirm.isPending}>Cancelar importação</Button>
            <Button
              variant="primary"
              loading={confirm.isPending}
              disabled={Boolean(mismatch) && !allowMismatch}
              onClick={() => {
                setAttempted(true);
                if (mappingInvalid || profileNameMissing) return;
                confirm.mutate();
              }}
            >
              Confirmar importação
            </Button>
          </div>
          <ConfirmDialog
            open={confirmCancel}
            title="Cancelar importação"
            message="O arquivo enviado será descartado e nada será importado."
            confirmLabel="Cancelar importação"
            cancelLabel="Voltar"
            destructive
            onCancel={() => setConfirmCancel(false)}
            onConfirm={async () => { await cancel.mutateAsync().catch(() => undefined); setConfirmCancel(false); }}
          />
        </div>
      )}

      {step === 3 && batchId && <Progress id={batchId} />}
    </>
  );
}

function OfxView({ preview, mismatch, allow, onAllow }: { preview: OfxPreview; mismatch: boolean; allow: boolean; onAllow: (v: boolean) => void }) {
  const a = preview.account;
  return (
    <>
      {mismatch && (
        <div role="alert" className="cartao pilha" style={{ padding: 'var(--e4)', borderColor: 'var(--cor-perigo, #b42318)' }}>
          <strong className="erro-texto">A conta do arquivo não corresponde à conta bancária selecionada.</strong>
          <span>Conta no arquivo: {[a.bankId, a.branchId, a.accountId].filter(Boolean).join(' / ') || '—'}. Confira se escolheu a conta certa.</span>
          <Checkbox label="Importar mesmo assim" checked={allow} onChange={(e) => onAllow(e.target.checked)} />
        </div>
      )}
      <div className="cartao pilha" style={{ padding: 'var(--e4)' }}>
        <div className="linha" style={{ flexWrap: 'wrap', gap: 'var(--e5)' }}>
          <span><span className="texto-suave">Conta do arquivo </span>{[a.bankId, a.branchId, a.accountId].filter(Boolean).join(' / ') || '—'}</span>
          <span><span className="texto-suave">Período </span>{preview.period.start ?? '—'} a {preview.period.end ?? '—'}</span>
          <span><span className="texto-suave">Transações </span>{preview.transactionCount}</span>
          {preview.invalidCount > 0 && <span><Badge tone="warning">{preview.invalidCount} inválidas</Badge></span>}
        </div>
        <div className="tabela-rolagem">
          <table className="tabela">
            <caption className="sr-only">Amostra das transações do arquivo</caption>
            <thead><tr><th>Data</th><th>Descrição</th><th className="num">Valor</th></tr></thead>
            <tbody>
              {preview.sample.map((t, i) => (
                <tr key={i}><td>{t.date}</td><td>{t.description}</td><td className="num"><Money cents={t.amountCents} /></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function TabularView({ preview, loading, onSheet }: { preview: TabularPreview; loading: boolean; onSheet: (s: string) => void }) {
  return (
    <div className="cartao pilha" style={{ padding: 'var(--e4)' }}>
      {preview.sheetNames && preview.sheetNames.length > 1 && (
        <Select label="Aba da planilha" value={preview.sheetName ?? ''} disabled={loading}
          onChange={(e) => onSheet(e.target.value)} options={preview.sheetNames.map((n) => ({ value: n, label: n }))} />
      )}
      <p className="texto-suave">{preview.rowCount} linhas de dados. Amostra das primeiras linhas:</p>
      {loading ? <Spinner label="Carregando aba" /> : (
        <div className="tabela-rolagem">
          <table className="tabela">
            <caption className="sr-only">Amostra do arquivo</caption>
            <thead><tr>{preview.headers.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
            <tbody>
              {preview.sampleRows.map((row, r) => (
                <tr key={r}>{preview.headers.map((_, c) => <td key={c}>{row[c] ?? ''}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Progress({ id }: { id: string }) {
  const batch = useQuery({
    queryKey: [...IMPORTS_KEY, 'detail', id],
    queryFn: ({ signal }) => api.get<ImportBatch>(`/imports/${id}`, undefined, signal),
    refetchInterval: (q) => (!q.state.data || isRunning(q.state.data.status) ? 2000 : false),
  });
  const b = batch.data;
  if (batch.isError) return <p className="erro-texto" role="alert">{errorMessage(batch.error)}</p>;
  if (!b || isRunning(b.status)) {
    return (
      <div className="cartao pilha" style={{ padding: 'var(--e5)' }} role="status">
        <Spinner label={b?.status === 'processing' ? 'Processando o arquivo…' : 'Aguardando na fila…'} />
        <span className="texto-suave">Você pode sair desta tela; o andamento fica em Importações.</span>
      </div>
    );
  }
  const s = b.stats;
  return (
    <div className="cartao pilha" style={{ padding: 'var(--e5)' }}>
      <div className="linha"><strong>Resultado</strong><BatchStatusBadge status={b.status} /></div>
      {b.error && <p className="erro-texto" role="alert">{b.error}</p>}
      <ul>
        <li>Importados: {s.imported ?? 0}</li>
        <li>Duplicados: {s.duplicates ?? 0}</li>
        <li>Rejeitados: {s.rejected ?? 0}</li>
        {(s.conflicts ?? 0) > 0 && <li>Conflitos: {s.conflicts}</li>}
      </ul>
      <div className="linha">
        <Link to={`/importacoes/${b.id}`}>Ver detalhes do lote</Link>
        <Link to="/importacoes">Voltar para importações</Link>
      </div>
    </div>
  );
}
