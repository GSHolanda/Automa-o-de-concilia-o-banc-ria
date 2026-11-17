import type { Db } from '../../db/context';

export const ONBOARDING_STEPS = [
  { key: 'company', title: 'Dados da empresa', required: true },
  { key: 'branding', title: 'Identidade visual', required: false },
  { key: 'bank_accounts', title: 'Contas bancárias', required: true },
  { key: 'structure', title: 'Unidades e centros de custo', required: false },
  { key: 'chart', title: 'Plano de contas e categorias', required: false },
  { key: 'import_profile', title: 'Perfil de importação', required: false },
  { key: 'rules', title: 'Regras de classificação', required: false },
  { key: 'users', title: 'Usuários', required: false },
] as const;

export type OnboardingStepKey = (typeof ONBOARDING_STEPS)[number]['key'];
export const ONBOARDING_STEP_KEYS = ONBOARDING_STEPS.map((step) => step.key) as [OnboardingStepKey, ...OnboardingStepKey[]];

/** Grava a marcação manual de uma etapa em `tenants.onboarding`. */
export async function markOnboardingStep(db: Db, tenantId: string, key: OnboardingStepKey, done: boolean): Promise<void> {
  await db.query(
    `UPDATE tenants
        SET onboarding = jsonb_set(
              jsonb_set(onboarding, '{steps}', COALESCE(onboarding -> 'steps', '{}'::jsonb)),
              ARRAY['steps', $2::text], to_jsonb($3::boolean))
      WHERE id = $1`,
    [tenantId, key, done],
  );
}

const EXISTS: Partial<Record<OnboardingStepKey, string>> = {
  bank_accounts: 'SELECT EXISTS (SELECT 1 FROM bank_accounts WHERE tenant_id = $1 AND active)',
  structure: 'SELECT EXISTS (SELECT 1 FROM org_nodes WHERE tenant_id = $1)',
  chart: 'SELECT EXISTS (SELECT 1 FROM chart_accounts WHERE tenant_id = $1)',
  import_profile: 'SELECT EXISTS (SELECT 1 FROM import_profiles WHERE tenant_id = $1)',
  rules: 'SELECT EXISTS (SELECT 1 FROM classification_rules WHERE tenant_id = $1)',
  users: 'SELECT (SELECT count(*) FROM users WHERE tenant_id = $1) > 1',
};

export interface OnboardingState {
  status: string;
  steps: Array<{ key: OnboardingStepKey; title: string; required: boolean; done: boolean }>;
  canComplete: boolean;
  hasBankAccount: boolean;
}

/** Etapa concluída: marcação manual, quando existe; senão, o que já está cadastrado. */
export async function loadOnboarding(db: Db, tenantId: string): Promise<OnboardingState> {
  const tenant = await db.query<{ status: string; onboarding: { steps?: Record<string, boolean> } | null }>(
    'SELECT status, onboarding FROM tenants WHERE id = $1',
    [tenantId],
  );
  const row = tenant.rows[0];
  const manual = row?.onboarding?.steps ?? {};
  const steps: OnboardingState['steps'] = [];
  let hasBankAccount = false;
  for (const step of ONBOARDING_STEPS) {
    const query = EXISTS[step.key];
    let detected = false;
    if (query) {
      const result = await db.query<{ found: boolean }>(`${query} AS found`, [tenantId]);
      detected = result.rows[0]?.found === true;
    }
    if (step.key === 'bank_accounts') hasBankAccount = detected;
    steps.push({ key: step.key, title: step.title, required: step.required, done: manual[step.key] ?? detected });
  }
  const requiredDone = steps.filter((step) => step.required).every((step) => step.done);
  return {
    status: row?.status ?? 'onboarding',
    steps,
    canComplete: row?.status === 'onboarding' && requiredDone && hasBankAccount,
    hasBankAccount,
  };
}
