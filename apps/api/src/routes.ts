import type { RouteDefinition } from './http/route';
import { routes as access } from './modules/access/routes';
import { routes as audit } from './modules/audit/routes';
import { routes as auth } from './modules/auth/routes';
import { routes as dashboard } from './modules/dashboard/routes';
import { routes as exportsRoutes } from './modules/exports/routes';
import { routes as imports } from './modules/imports/routes';
import { routes as jobs } from './modules/jobs/routes';
import { routes as onboarding } from './modules/onboarding/routes';
import { routes as platform } from './modules/platform/routes';
import { routes as reconciliation } from './modules/reconciliation/routes';
import { routes as registry } from './modules/registry/definitions';
import { routes as settings } from './modules/settings/routes';

/** Lista central das rotas da API. Cada módulo novo entra aqui, uma linha por módulo. */
export const routes: readonly RouteDefinition[] = [
  ...auth,
  ...access,
  ...audit,
  ...platform,
  ...settings,
  ...registry,
  ...onboarding,
  ...jobs,
  ...imports,
  ...reconciliation,
  ...dashboard,
  ...exportsRoutes,
];
