import type { ModuleKey, PermissionKey } from '@concilia/core/shared';

export interface Branding {
  primaryColor?: string;
  logoDataUrl?: string | null;
}

export interface LicenseInfo {
  planCode: string;
  planName: string;
  status: string;
  validUntil: string | null;
  readOnly: boolean;
  readOnlyReason: string | null;
  limits: Record<string, unknown>;
}

/** Resposta de GET /auth/me e POST /auth/login. */
export interface Me {
  user: { id: string; name: string; email: string; mustChangePassword: boolean };
  tenant: {
    id: string;
    slug: string;
    tradeName: string;
    legalName: string;
    status: string;
    onboarding?: unknown;
  } | null;
  role: { key: string; name: string } | null;
  permissions: PermissionKey[];
  modules: ModuleKey[];
  license: LicenseInfo | null;
  branding: Branding | null;
  csrfToken: string;
  isPlatformAdmin: boolean;
  productName: string;
  deploymentMode: string;
}
