-- Pre-existing users were never asked to verify email; do not lock anyone out.
UPDATE users SET email_verified = true;

-- Login-capable users get a normalized username plus preserved display form.
UPDATE users
  SET display_username = username
  WHERE role IN ('owner', 'admin', 'viewer') AND display_username IS NULL;
UPDATE users
  SET username = lower(username)
  WHERE role IN ('owner', 'admin', 'viewer');

-- Credential provider rows from existing password hashes. An empty-string
-- hash can never verify, so it must not become a credential login method.
INSERT INTO auth_accounts (id, account_id, provider_id, user_id, password, created_at, updated_at)
SELECT gen_random_uuid()::text, id::text, 'credential', id, password_hash, now(), now()
FROM users
WHERE password_hash IS NOT NULL AND password_hash <> ''
ON CONFLICT ON CONSTRAINT auth_accounts_provider_account_unique DO NOTHING;

-- Plex provider rows from linked plex accounts. plex_accounts itself stays;
-- it holds Plex domain data (machineIdentifier linkage, allowLogin).
INSERT INTO auth_accounts (id, account_id, provider_id, user_id, access_token, created_at, updated_at)
SELECT gen_random_uuid()::text, plex_account_id, 'plex', user_id, plex_token, now(), now()
FROM plex_accounts
ON CONFLICT ON CONSTRAINT auth_accounts_provider_account_unique DO NOTHING;
