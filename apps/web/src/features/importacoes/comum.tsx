import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useAuth } from '../../auth';
import { Badge, type BadgeTone } from '../../components/Badge';

export type SourceKind = 'bank' | 'ledger';
export type FileFormat = 'ofx' | 'csv' | 'xlsx';
export type BatchStatus = 'uploaded' | 'queued' | 'processing' | 'completed' | 'completed_with_errors' | 'failed' | 'canceled';

export interface ImportStats {
  totalRows?: number;
  imported?: number;
  duplicates?: number;
  rejected?: number;
  conflicts?: number;
  skipped?: number;
  duplicateSuspects?: number;
  periodStart?: string | null;
  periodEnd?: string | null;
}

export interface JobInfo {
  id: string;
  status: string;
  attempts: number | null;
  lastError: string | null;
}

export interface ImportBatch {
  id: string;
  sourceKind: SourceKind;
  bankAccountId: string | null;
  bankAccountName: string | null;
  profileId: string | null;
  origin: string;
  fileName: string;
  fileFormat: FileFormat;
  fileSize: number;
  status: BatchStatus;
  stats: ImportStats;
  error: string | null;
  createdBy: string | null;
  createdAt: string;
  processedAt: string | null;
  job: JobInfo | null;
}

export const IMPORTS_KEY = ['imports'] as const;

export const SOURCE_LABEL: Record<SourceKind, string> = { bank: 'Extrato bancário', ledger: 'Lançamentos' };
export const FORMAT_LABEL: Record<string, string> = { ofx: 'OFX', csv: 'CSV', xlsx: 'Planilha (XLSX)' };
export const STATUS_LABEL: Record<BatchStatus, string> = {
  uploaded: 'Aguardando confirmação',
  queued: 'Na fila',
  processing: 'Processando',
  completed: 'Concluída',
  completed_with_errors: 'Concluída com rejeições',
  failed: 'Falhou',
  canceled: 'Cancelada',
};
const STATUS_TONE: Record<BatchStatus, BadgeTone> = {
  uploaded: 'warning',
  queued: 'neutral',
  processing: 'info',
  completed: 'success',
  completed_with_errors: 'warning',
  failed: 'danger',
  canceled: 'neutral',
};
export const JOB_LABEL: Record<string, string> = {
  queued: 'Na fila',
  running: 'Em andamento',
  succeeded: 'Concluído',
  dead: 'Falha definitiva',
  canceled: 'Cancelado',
};

export function BatchStatusBadge({ status }: { status: BatchStatus }) {
  return <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{STATUS_LABEL[status] ?? status}</Badge>;
}

export const isRunning = (status: BatchStatus | undefined) => status === 'queued' || status === 'processing';

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace('.', ',')} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

/** Nomes dos autores (só quem gerencia usuários consegue listá-los; os demais veem "—"). */
export function useUserNames(): (id: string | null) => string {
  const { can } = useAuth();
  const users = useQuery({
    queryKey: ['users', 'names'],
    enabled: can('users.manage'),
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: () => api.get<{ items: { id: string; name: string }[] }>('/users'),
  });
  const map = new Map((users.data?.items ?? []).map((u) => [u.id, u.name]));
  return (id) => (id ? (map.get(id) ?? '—') : 'Sistema');
}
