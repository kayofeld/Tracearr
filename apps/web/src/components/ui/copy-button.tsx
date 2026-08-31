import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

const CONFIRMATION_MS = 1500;

type CopyButtonProps = Omit<ComponentProps<typeof Button>, 'value' | 'onClick' | 'children'> & {
  value: string;
  /** Accessible name for the button, e.g. "Copy API key". */
  label: string;
  /** Renders the label beside the icon; off by default, which is the icon-only shape. */
  showLabel?: boolean;
};

export function CopyButton({
  value,
  label,
  showLabel = false,
  variant = 'outline',
  size = showLabel ? 'default' : 'icon',
  ...props
}: CopyButtonProps) {
  const { t } = useTranslation('notifications');
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), CONFIRMATION_MS);
    } catch {
      toast.error(t('toast.error.copyFailed'));
    }
  };

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      aria-label={label}
      title={label}
      onClick={() => void copy()}
      {...props}
    >
      {copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
      {showLabel && label}
    </Button>
  );
}
