import { importProcessHandler } from '../modules/imports/process';
import type { JobHandler } from './types';

/** Manipuladores de cada tipo de trabalho. Cada tipo novo entra aqui. */
export const jobHandlers: Readonly<Record<string, JobHandler>> = {
  'import.process': importProcessHandler,
};
