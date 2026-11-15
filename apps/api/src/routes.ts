import type { RouteDefinition } from './http/route';
import { routes as access } from './modules/access/routes';
import { routes as audit } from './modules/audit/routes';
import { routes as auth } from './modules/auth/routes';
import { routes as platform } from './modules/platform/routes';

/** Lista central das rotas da API. Cada módulo novo entra aqui. */
export const routes: readonly RouteDefinition[] = [...auth, ...access, ...audit, ...platform];
