-- Apply AFTER 20260915_authenticated_registration.sql. Deploy both updated clients together.
BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS profiles_email_lower_unique ON public.profiles (lower(email));
CREATE TABLE IF NOT EXISTS public.profile_devices (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  fingerprint text NOT NULL CHECK (length(trim(fingerprint)) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, fingerprint)
);
ALTER TABLE public.profile_devices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.profile_devices FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.profiles FROM authenticated;

-- Import known devices; unclaimed legacy profiles are imported upon verified registration.
INSERT INTO public.profile_devices(user_id, fingerprint)
SELECT user_id, device_fingerprint FROM public.profiles
WHERE user_id IS NOT NULL AND nullif(device_fingerprint, '') IS NOT NULL
ON CONFLICT DO NOTHING;
UPDATE public.profiles SET device_fingerprint = NULL
WHERE user_id IS NOT NULL AND nullif(device_fingerprint, '') IS NOT NULL;

CREATE OR REPLACE FUNCTION public.get_catalog_profile(p_fingerprint text)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$
  SELECT to_jsonb(p) || jsonb_build_object(
    'device_authorized', EXISTS(SELECT 1 FROM public.profile_devices d
      WHERE d.user_id = auth.uid() AND d.fingerprint = p_fingerprint),
    'device_count', (SELECT count(*) FROM public.profile_devices d WHERE d.user_id = auth.uid())
  ) FROM public.profiles p WHERE p.user_id = auth.uid();
$$;
REVOKE ALL ON FUNCTION public.get_catalog_profile(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_catalog_profile(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.register_catalog_profile(p_profile jsonb, p_fingerprint text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_email text := lower(auth.jwt() ->> 'email');
  v_row public.profiles%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR coalesce(v_email, '') = '' THEN
    RAISE EXCEPTION 'Confirme seu e-mail antes de cadastrar.';
  END IF;
  IF coalesce(length(trim(p_fingerprint)), 0) = 0 OR length(p_fingerprint) > 200 THEN
    RAISE EXCEPTION 'Dispositivo inválido.';
  END IF;
  IF coalesce(trim(p_profile ->> 'full_name'), '') = ''
     OR coalesce(trim(p_profile ->> 'cpf_cnpj'), '') = ''
     OR coalesce(p_profile ->> 'person_type', '') NOT IN ('pf', 'pj') THEN
    RAISE EXCEPTION 'Preencha nome, CPF/CNPJ e tipo de pessoa.';
  END IF;
  -- Serialize simultaneous first registrations for the same verified email.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_email, 0));
  SELECT * INTO v_row FROM public.profiles WHERE lower(email) = v_email FOR UPDATE;
  IF FOUND THEN
    IF v_row.user_id IS NOT NULL AND v_row.user_id <> v_uid THEN
      RAISE EXCEPTION 'Cadastro vinculado a outra conta. Contate o administrador.';
    END IF;
    -- Claim legacy row only after email verification; preserve status and device.
    UPDATE public.profiles SET user_id = v_uid WHERE id = v_row.id;
    IF v_row.status = 'block' THEN
      RETURN public.get_catalog_profile(p_fingerprint);
    END IF;
    UPDATE public.profiles SET
      full_name = trim(p_profile ->> 'full_name'), person_type = p_profile ->> 'person_type',
      cpf_cnpj = p_profile ->> 'cpf_cnpj', country = p_profile ->> 'country',
      state = p_profile ->> 'state', city = p_profile ->> 'city',
      phone_area = p_profile ->> 'phone_area', phone_number = p_profile ->> 'phone_number',
      device_fingerprint = v_row.device_fingerprint
    WHERE id = v_row.id RETURNING * INTO v_row;
  ELSE
    INSERT INTO public.profiles (user_id, email, full_name, person_type, cpf_cnpj,
      country, state, city, phone_area, phone_number, device_fingerprint, status)
    VALUES (v_uid, v_email, trim(p_profile ->> 'full_name'), p_profile ->> 'person_type',
      p_profile ->> 'cpf_cnpj', p_profile ->> 'country', p_profile ->> 'state',
      p_profile ->> 'city', p_profile ->> 'phone_area', p_profile ->> 'phone_number',
      p_fingerprint, 'approved') RETURNING * INTO v_row;
  END IF;
  -- Preserve the legacy device once, then use the registry exclusively.
  IF nullif(v_row.device_fingerprint, '') IS NOT NULL THEN
    INSERT INTO public.profile_devices(user_id, fingerprint)
    VALUES (v_uid, v_row.device_fingerprint) ON CONFLICT DO NOTHING;
    UPDATE public.profiles SET device_fingerprint = NULL WHERE id = v_row.id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profile_devices WHERE user_id = v_uid AND fingerprint = p_fingerprint) THEN
    IF (SELECT count(*) FROM public.profile_devices WHERE user_id = v_uid) >= 2 THEN
      RAISE EXCEPTION 'Limite de 2 dispositivos atingido. Solicite ao administrador a remoção de um dispositivo antigo.';
    END IF;
    INSERT INTO public.profile_devices(user_id, fingerprint) VALUES (v_uid, p_fingerprint);
  END IF;
  RETURN public.get_catalog_profile(p_fingerprint);
END;
$$;
REVOKE ALL ON FUNCTION public.register_catalog_profile(jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_catalog_profile(jsonb, text) TO authenticated;
COMMIT;
