import { importProcessHandler } from '../modules/imports/process';
import { connectorPullHandler } from '../modules/integrations/pull';
import { notificationDeliverHandler } from '../modules/notifications/deliver';
import { reconciliationRunHandler } from '../modules/reconciliation/run';
import type { JobHandler } from './types';

/** Manipuladores de cada tipo de trabalho. Cada tipo novo entra aqui. */
export const jobHandlers: Readonly<Record<string, JobHandler>> = {
  'import.process': importProcessHandler,
  'reconciliation.run': reconciliationRunHandler,
  'notification.deliver': notificationDeliverHandler,
  'connector.pull': connectorPullHandler,
};
