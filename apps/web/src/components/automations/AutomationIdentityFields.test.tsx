/** Real i18n: the point of these fields is that the two labels read as words. */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { initI18n } from '@tracearr/translations';
import { AUTOMATION_NAME_MAX } from '@tracearr/shared';
import { FieldError } from '@/components/ui/field';
import { AutomationIdentityFields } from './AutomationIdentityFields';

beforeAll(async () => {
  await initI18n({ lng: 'en' });
});

function renderFields(overrides: { nameInvalid?: boolean } = {}) {
  const onNameChange = vi.fn();
  const onDescriptionChange = vi.fn();

  render(
    <AutomationIdentityFields
      name="Impossible travel"
      onNameChange={onNameChange}
      description="Raise a violation when travel between two streams is impossible."
      onDescriptionChange={onDescriptionChange}
      nameId="automation-name"
      descriptionId="automation-description"
      nameInvalid={overrides.nameInvalid}
      nameError={overrides.nameInvalid === true ? <FieldError>Give it a name.</FieldError> : null}
    />
  );

  return { onNameChange, onDescriptionChange, user: userEvent.setup() };
}

describe('AutomationIdentityFields', () => {
  it('shows both values behind labels a screen reader can reach', () => {
    renderFields();

    expect(screen.getByLabelText('Name')).toHaveValue('Impossible travel');
    expect(screen.getByLabelText('Description')).toHaveValue(
      'Raise a violation when travel between two streams is impossible.'
    );
  });

  it('reports what was typed rather than holding it', async () => {
    const { onNameChange, onDescriptionChange, user } = renderFields();

    await user.type(screen.getByLabelText('Name'), '!');
    await user.type(screen.getByLabelText('Description'), '!');

    expect(onNameChange).toHaveBeenCalledWith('Impossible travel!');
    expect(onDescriptionChange).toHaveBeenCalledWith(
      'Raise a violation when travel between two streams is impossible.!'
    );
  });

  it('stops the name at the length the schema allows', () => {
    renderFields();

    expect(screen.getByLabelText('Name')).toHaveAttribute('maxLength', String(AUTOMATION_NAME_MAX));
  });

  it('marks a faulted name and says what is wrong under it', () => {
    renderFields({ nameInvalid: true });

    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Give it a name.')).toBeInTheDocument();
    expect(screen.getByLabelText('Description')).not.toHaveAttribute('aria-invalid', 'true');
  });
});
