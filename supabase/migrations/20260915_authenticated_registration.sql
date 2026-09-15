-- Apply in Supabase SQL Editor before distributing the updated client.
-- Existing profiles must have unique emails ignoring case; fail rather than merge identities.
BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS profiles_email_lower_unique ON public.profiles (lower(email));
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.profiles FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.profiles FROM authenticated;
GRANT SELECT ON public.profiles TO authenticated;

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
    IF v_row.status = 'block' OR
       (nullif(v_row.device_fingerprint, '') IS NOT NULL AND v_row.device_fingerprint <> p_fingerprint) THEN
      SELECT * INTO v_row FROM public.profiles WHERE id = v_row.id;
      RETURN to_jsonb(v_row);
    END IF;
    UPDATE public.profiles SET
      full_name = trim(p_profile ->> 'full_name'), person_type = p_profile ->> 'person_type',
      cpf_cnpj = p_profile ->> 'cpf_cnpj', country = p_profile ->> 'country',
      state = p_profile ->> 'state', city = p_profile ->> 'city',
      phone_area = p_profile ->> 'phone_area', phone_number = p_profile ->> 'phone_number',
      device_fingerprint = p_fingerprint
    WHERE id = v_row.id RETURNING * INTO v_row;
  ELSE
    INSERT INTO public.profiles (user_id, email, full_name, person_type, cpf_cnpj,
      country, state, city, phone_area, phone_number, device_fingerprint, status)
    VALUES (v_uid, v_email, trim(p_profile ->> 'full_name'), p_profile ->> 'person_type',
      p_profile ->> 'cpf_cnpj', p_profile ->> 'country', p_profile ->> 'state',
      p_profile ->> 'city', p_profile ->> 'phone_area', p_profile ->> 'phone_number',
      p_fingerprint, 'approved') RETURNING * INTO v_row;
  END IF;
  RETURN to_jsonb(v_row);
END;
$$;
REVOKE ALL ON FUNCTION public.register_catalog_profile(jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_catalog_profile(jsonb, text) TO authenticated;
COMMIT;
