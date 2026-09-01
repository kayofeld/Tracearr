/**
 * The violations alias filter
 *
 * Every violation read path composes this one fragment. The assertions render
 * it rather than compare object identity, so a site that hand-writes the same
 * predicate with different semantics still fails here.
 */

import { describe, it, expect } from 'vitest';
import { and } from 'drizzle-orm';
import { renderSql } from '../../../test/helpers.js';
import { VIOLATION_ALIAS_SQL, violationAliasConditions } from '../aliasFilter.js';

function render(conditions: ReturnType<typeof violationAliasConditions>) {
  const fragment = and(...conditions);
  if (!fragment) throw new Error('alias conditions rendered nothing');
  const { sql, params } = renderSql(fragment);
  return { text: sql.replace(/\s+/g, ' ').trim(), params };
}

describe('violationAliasConditions', () => {
  it('keeps completed policy runs, which excludes notification and stopped or errored runs', () => {
    const { text, params } = render(violationAliasConditions());

    expect(text).toContain('automation_runs.kind =');
    expect(text).toContain('automation_runs.outcome =');
    expect(params).toContain('policy');
    expect(params).toContain('completed');
  });

  it('leaves user-less runs in unless the caller asks for a user', () => {
    const { text } = render(violationAliasConditions());

    expect(text).not.toContain('automation_runs.server_user_id');
  });

  it('excludes user-less runs when the caller requires a user', () => {
    const { text } = render(violationAliasConditions({ requireUser: true }));

    expect(text).toContain('automation_runs.server_user_id is not null');
  });
});

describe('VIOLATION_ALIAS_SQL', () => {
  it('filters the same two columns for raw-SQL callers', () => {
    const { sql } = renderSql(VIOLATION_ALIAS_SQL);

    expect(sql.replace(/\s+/g, ' ').trim()).toBe("v.kind = 'policy' AND v.outcome = 'completed'");
  });
});
