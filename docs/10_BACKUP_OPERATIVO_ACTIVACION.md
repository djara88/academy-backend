# Syncademia — Backup operativo y recuperación

## Objetivo

Este procedimiento prioriza recuperación ante incidentes. Alta disponibilidad queda fuera de alcance en esta fase.

El código fuente se conserva en GitHub y permite reconstruir los despliegues de Render/Vercel. El componente que necesita copia independiente es Supabase: base de datos, usuarios/Auth y objetos de Storage.

## Alcance del backup automático

El workflow `.github/workflows/production-backup.yml` genera diariamente:

1. `roles.sql` — roles PostgreSQL compatibles con restauración.
2. `schema.sql` — tablas, índices, funciones, triggers, RLS y esquema de aplicación.
3. `data.sql` — datos PostgreSQL, incluido Auth según el proceso oficial de Supabase.
4. `history_schema.sql` y `history_data.sql` — historial de migraciones Supabase CLI.
5. copia binaria de todos los objetos de Supabase Storage.
6. manifiesto con commit, fecha, versiones y nombres de variables de entorno requeridas.
7. checksums SHA-256.

El paquete se cifra con AES-256-CBC + PBKDF2 antes de salir del runner y se conserva como artefacto privado de GitHub Actions durante 30 días.

## Storage actualmente protegido

A la fecha de creación de este documento existen los buckets:

- `fotos_alumnos` (privado)
- `logos-escuelas` (público)
- `matriculas-pdf` (privado)
- `informes-alumnos` (privado)

Los archivos físicos de Storage no forman parte de un backup normal de PostgreSQL; por eso se exportan explícitamente.

## Secretos requeridos en GitHub

En `academy-backend` → Settings → Secrets and variables → Actions → Repository secrets deben existir:

- `SUPABASE_DB_URL`: connection string Session Pooler o directa con contraseña de base de datos.
- `SUPABASE_URL`: URL del proyecto productivo.
- `SUPABASE_SERVICE_ROLE_KEY`: service role del proyecto productivo.
- `BACKUP_PASSPHRASE`: frase larga y aleatoria usada exclusivamente para cifrar backups.

### Reglas

- Nunca escribir estos valores en código, issues, PR o documentación.
- `BACKUP_PASSPHRASE` debe guardarse además en un gestor de contraseñas externo. Si se pierde, los backups cifrados no se pueden recuperar.
- Rotar la frase solo cuando se haya definido cómo conservar las frases necesarias para backups históricos aún vigentes.

## Frecuencia

- Automático: todos los días a las 07:15 UTC.
- Manual: botón `Run workflow` en GitHub Actions ante cambios de alto riesgo o antes de migraciones importantes.
- Retención inicial: 30 días en GitHub Actions.

## Activación inicial

1. Obtener en Supabase → Connect la cadena Session Pooler.
2. Incorporar la contraseña de base de datos.
3. Crear los cuatro Repository Secrets anteriores.
4. Fusionar el PR que contiene el workflow.
5. Abrir Actions → `Production Backup` → `Run workflow`.
6. Esperar resultado verde.
7. Abrir el run y comprobar que existe un artifact `syncademia-production-backup-*`.
8. Descargar el artifact una vez y verificar que contiene solamente un `.enc` y su `.sha256`; no debe contener SQL en claro.

## Recuperación ante incidente

### Caso A — Backend Render roto pero Supabase sano

No restaurar la base.

1. Desplegar el commit estable de GitHub en Render nuevo o recuperar servicio existente.
2. Configurar variables de entorno.
3. Validar `/health`.
4. Cambiar endpoint/API si corresponde.

### Caso B — Despliegue o migración dañó datos de Supabase

1. Congelar escrituras de la aplicación si es posible.
2. Identificar el último backup anterior al incidente.
3. Preferir restauración en un proyecto Supabase temporal/nuevo antes de sobrescribir producción.
4. Validar conteos y flujos funcionales.
5. Solo después decidir el corte a la instancia restaurada.

### Caso C — Proyecto Supabase completo inutilizable

1. Crear un proyecto Supabase nuevo en región compatible.
2. Configurar extensiones y ajustes necesarios.
3. Obtener `TARGET_SUPABASE_DB_URL`, `TARGET_SUPABASE_URL` y `TARGET_SUPABASE_SERVICE_ROLE_KEY`.
4. Descargar el artifact del backup elegido.
5. Disponer de `psql`, Node.js y dependencias del backend.
6. Ejecutar:

```bash
export BACKUP_PASSPHRASE='...'
export TARGET_SUPABASE_DB_URL='...'
export TARGET_SUPABASE_URL='...'
export TARGET_SUPABASE_SERVICE_ROLE_KEY='...'

bash scripts/backup/restore-backup.sh \
  syncademia-production-YYYYMMDDTHHMMSSZ.tar.gz.enc \
  syncademia-production-YYYYMMDDTHHMMSSZ.tar.gz.enc.sha256
```

7. Configurar SMTP/Auth/redirect URLs y cualquier ajuste de plataforma que no viva en PostgreSQL.
8. Actualizar en Render los secretos que apunten al nuevo Supabase.
9. Actualizar frontend si utiliza URL/clave pública del proyecto.
10. Validar smoke test completo antes de abrir tráfico.

## Checklist mínimo de validación posterior

- login Director funciona;
- login Profesor funciona;
- acceso Apoderado PRO funciona si aplica;
- academias y usuarios tienen conteos esperados;
- alumnos e inscripciones aparecen una sola vez;
- finanzas y cobros cuadran;
- asistencia/evaluaciones se cargan;
- imágenes, logos, PDFs e informes se descargan;
- RLS evita acceso entre academias;
- Realtime/chat funciona;
- backend `/health` retorna 200;
- Home y aplicación cargan desde Vercel.

## Limitaciones conocidas

- Los backups no contienen valores secretos de Render/Vercel/GitHub. Debe existir un registro seguro externo de secretos productivos.
- Configuración de proveedores Auth, SMTP, DNS y dominios puede requerir configuración manual al restaurar a un proyecto Supabase nuevo.
- El backup diario inicial entrega un RPO práctico de hasta 24 horas. Para reducirlo en el futuro se debe aumentar frecuencia o contratar PITR.
- Esta fase entrega capacidad de recuperación, no failover automático ni alta disponibilidad.

## Prueba de restauración

No considerar el sistema de backup “cerrado” hasta completar al menos una restauración controlada en un proyecto temporal y documentar:

- fecha;
- backup utilizado;
- duración total (RTO medido);
- diferencias encontradas;
- correcciones necesarias;
- resultado del smoke test.

Después de la primera prueba, repetir trimestralmente y después de cambios estructurales importantes en Auth, Storage o base de datos.
