import type { ConditionEvidence, RunSubject } from '@tracearr/shared';
import { fieldLabel, operatorLabel, type Translate } from './conditionFields';

/** A threshold or a reading, as the reader would say it. */
export function valueText(t: Translate, value: unknown): string {
  if (typeof value === 'boolean') {
    return value ? t('automations.builder.conditions.yes') : t('automations.builder.conditions.no');
  }
  if (Array.isArray(value)) return value.map((entry) => String(entry)).join(', ');
  if (value === null || value === undefined) return '—';
  return String(value);
}

/** What was checked, against what. */
export function conditionText(t: Translate, evidence: ConditionEvidence): string {
  return `${fieldLabel(t, evidence.field)} ${operatorLabel(t, evidence.operator)} ${valueText(t, evidence.threshold)}`;
}

/** Who a run was about: the person behind the account, or the item for a media run. */
export function runWho(subject: RunSubject): string | null {
  if (subject.kind === 'media') return subject.name;
  if (subject.kind === 'server' || subject.kind === 'install') return null;
  return subject.personName ?? subject.name;
}

/** Where it happened: the library for a media run, the server for everything else. */
export function runWhere(subject: RunSubject): string | null {
  if (subject.kind === 'media') return subject.libraryName ?? subject.serverName;
  return subject.serverName;
}
