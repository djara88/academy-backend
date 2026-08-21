# Auditoría RLS de solo lectura en Lestra

Este procedimiento permite simular cómo ve la base de datos un usuario autenticado de Supabase **sin crear usuarios, academias ni datos de prueba**.

La prueba está diseñada para ejecutarse en el SQL Editor de Supabase y usa una transacción `READ ONLY`, `SET LOCAL ROLE authenticated` y `ROLLBACK`.

## Por qué es segura

- `BEGIN TRANSACTION READ ONLY` impide escrituras dentro de la transacción.
- `SET LOCAL ROLE authenticated` cambia temporalmente el rol PostgreSQL solo dentro de esa transacción.
- `SET LOCAL request.jwt.claims` simula el contenido mínimo de un JWT de Supabase.
- `ROLLBACK` termina la transacción y descarta cualquier estado local.
- No requiere contraseñas, correos, tokens reales ni `service_role`.

## Paso 1: elegir un usuario normal existente

Ejecutar esta consulta por separado en el SQL Editor:

```sql
select id, academia_id, rol
from public.usuarios
where academia_id is not null
limit 5;
```

Elegir el `id` UUID de un usuario normal de academia. No usar el superadministrador para esta prueba.

## Paso 2: probar el aislamiento del usuario

Reemplazar `REEMPLAZAR_UUID_USUARIO` por el UUID elegido:

```sql
begin transaction read only;

set local role authenticated;
set local request.jwt.claims = '{"sub":"REEMPLAZAR_UUID_USUARIO","role":"authenticated"}';

-- Debe coincidir con el UUID que se puso arriba.
select auth.uid() as usuario_simulado;

-- En el diseño actual de Lestra, un usuario normal debe ver solo su academia.
select count(*) as academias_visibles
from public.academias;

-- En acceso directo a Supabase, el usuario solo debe ver su propia fila de usuario.
select count(*) as usuarios_visibles
from public.usuarios;

-- Comprobación de privilegios sobre tablas sensibles: deben ser false.
select
  has_table_privilege(current_user, 'public.jugadores', 'select') as jugadores_direct_select,
  has_table_privilege(current_user, 'public.pagos', 'select') as pagos_direct_select,
  has_table_privilege(current_user, 'public.deportista_salud', 'select') as salud_direct_select,
  has_table_privilege(current_user, 'public.payment_gateway_orders', 'select') as gateway_orders_direct_select;

rollback;
```

### Resultado esperado

Para un usuario normal de una academia:

- `usuario_simulado`: el UUID elegido.
- `academias_visibles`: `1`.
- `usuarios_visibles`: `1`.
- Los cuatro privilegios sobre tablas sensibles: `false`.

Si cualquiera de esos resultados cambia, no se debe modificar RLS a ciegas: primero hay que revisar políticas y grants.

## Paso 3: probar un UUID autenticado sin perfil Lestra

Este UUID es deliberadamente ficticio:

```sql
begin transaction read only;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';

select auth.uid() as usuario_simulado;
select count(*) as academias_visibles from public.academias;
select count(*) as usuarios_visibles from public.usuarios;

rollback;
```

Resultado esperado:

- `academias_visibles`: `0`.
- `usuarios_visibles`: `0`.

## Reglas de seguridad

1. No usar `service_role` para simular usuarios.
2. No pegar contraseñas, correos ni tokens reales en el SQL Editor para esta prueba.
3. No reemplazar `READ ONLY` por una transacción normal.
4. Mantener siempre el `ROLLBACK` al final.
5. No agregar `INSERT`, `UPDATE`, `DELETE`, `ALTER`, `DROP` o `CREATE` a este procedimiento.
6. Si una consulta devuelve `permission denied`, eso puede ser exactamente la protección esperada; no conceder permisos para "hacer pasar" la prueba.

## Qué está simulando realmente

Supabase convierte una petición autenticada en el rol PostgreSQL `authenticated` y expone los claims del JWT a PostgreSQL. `auth.uid()` obtiene el claim `sub`. Este procedimiento reproduce esas dos condiciones sin utilizar un token real.

La prueba sirve para verificar **qué puede leer directamente un cliente Supabase**. No reemplaza las pruebas del backend Express, de Render ni de los endpoints públicos.
