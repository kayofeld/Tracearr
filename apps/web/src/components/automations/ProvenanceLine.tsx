import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import type { Automation } from '@tracearr/shared';
import { templateName } from '@/lib/automations';

/** Where an automation came from: the template behind it, or the one it left. */
export function ProvenanceLine({ automation }: { automation: Automation }) {
  const { t } = useTranslation('pages');
  const { template, origin } = automation;

  if (template) {
    const name = templateName(t, { slug: template.slug, name: template.name });
    const version = t('automations.template.version', { version: template.version });

    if (template.source === 'builtin') {
      return <Line>{t('automations.provenance.builtin', { name, version })}</Line>;
    }
    const date = format(new Date(template.addedAt), 'PP');

    if (template.source === 'import') {
      return (
        <Line>
          {template.author
            ? t('automations.provenance.importedBy', {
                name,
                version,
                date,
                author: template.author,
              })
            : t('automations.provenance.imported', { name, version, date })}
        </Line>
      );
    }
    return <Line>{t('automations.provenance.saved', { name, version, date })}</Line>;
  }

  if (!origin) return null;

  return (
    <Line>
      {origin.name
        ? t('automations.provenance.customized', { name: origin.name })
        : t('automations.provenance.customizedFromRemoved')}
    </Line>
  );
}

function Line({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground text-xs">{children}</p>;
}
