-- Hardening preventivo: las funciones nuevas no deben quedar expuestas por defecto.
-- Los RPC de backend se habilitan explícitamente a service_role.

alter default privileges for role postgres in schema public
  revoke execute on functions from public;

alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated;

alter default privileges for role postgres in schema public
  grant execute on functions to service_role;

-- El schema private es interno: cualquier ejecución debe habilitarse de forma explícita.
alter default privileges for role postgres in schema private
  revoke execute on functions from public;

alter default privileges for role postgres in schema private
  revoke execute on functions from anon, authenticated;
