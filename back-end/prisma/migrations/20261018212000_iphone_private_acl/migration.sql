-- Phone tables contain private grants and encrypted command payloads, not public DTOs.
-- Backend table owners/service roles keep access; Data API clients use Rose HTTP APIs.
ALTER TABLE public."IPhoneDevice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."IPhoneLease" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."IPhoneOperation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."IPhoneAcquireIntent" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public."IPhoneDevice", public."IPhoneLease",
  public."IPhoneOperation", public."IPhoneAcquireIntent" FROM PUBLIC;
REVOKE ALL ON SEQUENCE public."IPhoneLease_ticket_seq" FROM PUBLIC;

-- Plain local Postgres need not have Supabase's client roles.
DO $$
DECLARE client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = client_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public."IPhoneDevice", public."IPhoneLease", public."IPhoneOperation", public."IPhoneAcquireIntent" FROM %I', client_role);
      EXECUTE format('REVOKE ALL ON SEQUENCE public."IPhoneLease_ticket_seq" FROM %I', client_role);
    END IF;
  END LOOP;
END $$;
