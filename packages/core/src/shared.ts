/**
 * Parte do domínio que pode ser carregada no navegador: tipos, catálogos e formatação.
 * Nada aqui depende de Node.js nem de bibliotecas de leitura de arquivos.
 */
export * from './money';
export * from './dates';
export * from './permissions';
export * from './modules';
export { ITEM_KINDS, ITEM_KIND_LABELS, MATCH_TYPES, type ItemKind, type RuleMatchType } from './classification';
export { RULE_CODES, RULE_LABELS, type RuleCode, type ScoreBreakdown } from './matching/types';
export type { ReconRules } from './matching/rules';
export type { TenantSettings, TenantSettingsPatch, ApprovalSettings } from './settings/schema';
export type { ImportProfileConfig, ImportProfileColumns } from './import-profile';
