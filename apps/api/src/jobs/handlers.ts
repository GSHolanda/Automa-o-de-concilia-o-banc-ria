import { importProcessHandler } from '../modules/imports/process';
import { purgeImportFilesHandler } from '../modules/imports/retention';
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
  // Mesmo texto de PURGE_FILES_JOB_TYPE (jobs/maintenance).
  'maintenance.purge_import_files': purgeImportFilesHandler,
};
