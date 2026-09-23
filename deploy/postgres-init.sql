-- Application role: neither superuser nor BYPASSRLS, so row-level security applies to it.
-- Local development only; production roles and secrets come from the secrets manager.
CREATE ROLE kuber_app LOGIN PASSWORD 'kuber_app' NOSUPERUSER NOBYPASSRLS;
