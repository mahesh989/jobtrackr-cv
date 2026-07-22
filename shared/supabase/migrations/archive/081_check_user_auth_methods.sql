-- ============================================================
-- 081_check_user_auth_methods.sql — SSO-only detection for
-- forgot-password, without touching Supabase's recovery-token cooldown
-- ============================================================
-- A user who signed up via Google has no email/password identity, so a
-- password-reset request for them is pointless. A previous attempt at
-- detecting this called admin.auth.admin.generateLink({ type: "recovery" })
-- before the real admin.auth.resetPasswordForEmail() send — both mint a
-- recovery token as far as GoTrue is concerned, and appear to share the
-- same per-identity cooldown, so the second call was always throttled by
-- the first on every single attempt (production bug, reverted).
--
-- This function reads auth.users/auth.identities directly (SECURITY
-- DEFINER, service_role only) — no Auth Admin API call, no interaction
-- with the recovery cooldown at all.
--
-- Read-only, additive: no existing table altered, no RLS changes.

CREATE OR REPLACE FUNCTION public.check_user_auth_methods(p_email text)
RETURNS TABLE(user_exists boolean, has_password boolean)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT
    EXISTS (SELECT 1 FROM auth.users u WHERE u.email = p_email) AS user_exists,
    EXISTS (
      SELECT 1 FROM auth.users u
      JOIN auth.identities i ON i.user_id = u.id
      WHERE u.email = p_email AND i.provider = 'email'
    ) AS has_password;
$$;

-- Callable only by the service-role client (server-side code) — never
-- exposed to the anon/authenticated PostgREST roles the browser client uses.
REVOKE ALL ON FUNCTION public.check_user_auth_methods(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_user_auth_methods(text) TO service_role;
