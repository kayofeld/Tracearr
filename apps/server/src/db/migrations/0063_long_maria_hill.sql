-- Login usernames become case-insensitively unique below (usernames were
-- normalized in 0061). When existing login-capable accounts genuinely
-- collide, fail with a clear remediation message instead of a raw
-- unique-violation from the index build.
DO $$
DECLARE
  conflict record;
  details text := '';
BEGIN
  FOR conflict IN
    SELECT lower(username) AS login_name,
           string_agg(username || ' (' || role || ', id ' || id || ')', ', ' ORDER BY created_at) AS accounts
    FROM users
    WHERE role IN ('owner', 'admin', 'viewer')
    GROUP BY lower(username)
    HAVING count(*) > 1
  LOOP
    details := details || E'\n  ' || conflict.login_name || ': ' || conflict.accounts;
  END LOOP;
  IF details <> '' THEN
    RAISE EXCEPTION USING
      message = 'Tracearr upgrade blocked: multiple login-capable users share the same username (case-insensitive):' || details,
      hint = 'Give each listed account a distinct username, then re-run migrations. Example: UPDATE users SET username = ''newname'' WHERE id = ''<id>'';';
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_login_username_unique" ON "users" USING btree (lower("username")) WHERE role IN ('owner', 'admin', 'viewer');
