import { useTranslation } from 'react-i18next';
import { ClipboardPaste, LayoutTemplate, ShieldCheck } from 'lucide-react';
import type { AutomationTemplateRef } from '@tracearr/shared';
import { Badge } from '@/components/ui/badge';
import { templateName } from '@/lib/automations';

/** The glyph says where the template came from; the word behind it is the filter's. */
const SOURCE_GLYPH = {
  builtin: ShieldCheck,
  import: ClipboardPaste,
  local: LayoutTemplate,
} as const;

interface TemplateBadgeProps {
  template: AutomationTemplateRef;
  /** Glyph and words with no chip, for a meta line that is muted already. */
  plain?: boolean;
}

/** The template a row is bound to, with a dot when the template has moved on. */
export function TemplateBadge({ template, plain = false }: TemplateBadgeProps) {
  const { t } = useTranslation('pages');
  const behind = template.version < template.currentVersion;
  const name = templateName(t, { slug: template.slug, name: template.name });
  const Glyph = SOURCE_GLYPH[template.source];

  const body = (
    <>
      <Glyph aria-hidden="true" className={plain ? 'size-3' : undefined} />
      <span className="sr-only">{t(`automations.filters.sources.${template.source}`)}</span>
      {name}
      {behind && (
        <span
          className="bg-primary size-1.5 rounded-full"
          aria-label={t('automations.template.updateAvailable')}
          title={t('automations.template.updateAvailable')}
        />
      )}
    </>
  );

  if (plain) return <span className="inline-flex items-center gap-1">{body}</span>;
  return <Badge variant="secondary">{body}</Badge>;
}
