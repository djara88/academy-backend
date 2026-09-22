# 01 — Arquitectura e inventario de Syncademia

## 1. Propósito

Este documento describe la arquitectura efectiva de producción, sus componentes, dependencias y puntos críticos. Debe ser la referencia inicial ante auditorías, cambios de infraestructura o incidentes.

## 2. Arquitectura actual

### Frontend
- Repositorio: `djara88/academy-frontend`.
- Stack: React 18, TypeScript, Vite, React Router, React Query, Axios, Recharts.
- Plataforma: Vercel.
- Proyecto: `academy-frontend`.
- Dominio operativo actual: `academy-frontend-wheat.vercel.app`.
- Despliegue: automático desde GitHub.

### Backend
- Repositorio: `djara88/academy-backend`.
- Stack: Node.js, Express 4, Supabase JS, PDFKit, Sharp, Multer.
- Plataforma: Render.
- Servicio: `academy-backend`.
- Región: Oregon, EE.UU.
- Rama: `main`.
- Build: `npm ci`.
- Inicio: `node server.js`.
- Health check: `/health`.
- Auto deploy: habilitado por commit.
- Estado actual de cómputo: plan Free, una instancia.

### Datos, identidad y API de datos
- Plataforma: Supabase.
- Proyecto: `soccermanager-db`.
- Región: Canadá Central (`ca-central-1`).
- Motor: PostgreSQL 17.
- Estado: `ACTIVE_HEALTHY`.
- Plan actual: Free.
- Uso: base relacional, Auth, Realtime/RLS y funciones SQL.
- El backend utiliza `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY`; estas variables son secretos y nunca deben escribirse en documentación.

### Código y CI
- Control de versiones: GitHub.
- Flujo recomendado: rama → PR → CI → merge `main` → despliegue automático.
- Backend: `node --test`.
- Frontend: TypeScript + Vite build + ESLint según workflow/proceso de validación.

## 3. Flujo lógico principal

`Usuario → Vercel frontend → Render API → Supabase Auth/PostgreSQL`

Integraciones adicionales pueden incluir:
- WhatsApp / webhook omnicanal.
- Mercado Pago mediante flujo de checkout/validación vigente.
- Brevo/correo cuando la función correspondiente se encuentra configurada.

## 4. Modelo funcional

Syncademia es SaaS multi-tenant. La unidad de aislamiento es `academia_id`.

Capacidades principales:
- academia, sedes, ramas y categorías;
- deportistas y apoderados;
- múltiples inscripciones deportivas para una misma persona;
- profesores y asignaciones;
- matrícula, mensualidades, cobros y pagos;
- asistencia;
- uniformes;
- partidos, torneos y estadísticas multideporte;
- evaluaciones y radar por disciplina;
- criterios personalizados desde planes habilitados;
- Apoderados PRO como add-on;
- privacidad, consentimientos y solicitudes de derechos;
- administración SaaS, planes, trial, promociones y monitor de sistema.

## 5. Seguridad implementada

El backend actual incluye:
- CORS con allowlist;
- `X-Content-Type-Options: nosniff`;
- `X-Frame-Options: DENY`;
- `Referrer-Policy: no-referrer`;
- `Permissions-Policy` restrictiva;
- HSTS cuando la conexión es HTTPS;
- rate limiting general y reforzado para operaciones sensibles;
- política de contraseña en altas/cambio de contraseña;
- JWT y autorización por rol/feature;
- RLS y funciones privadas en Supabase para determinados accesos Realtime;
- graceful shutdown ante `SIGTERM`/`SIGINT`;
- timeouts HTTP configurables;
- monitor de fallas y métricas internas.

## 6. Estado efímero relevante

Actualmente existen componentes de estado en memoria de proceso, entre ellos presencia de usuarios y ciertos mecanismos de deduplicación/cache de corta duración.

**Consecuencia:** antes de escalar a dos o más instancias, cualquier métrica que requiera visión global —especialmente usuarios concurrentes— debe moverse a un store compartido (por ejemplo Redis/Key Value o mecanismo equivalente). Los caches de optimización pueden permanecer locales si no son fuente de verdad.

## 7. Puntos únicos de falla actuales

1. Una sola instancia Render Free.
2. Supabase en plan Free sin backup automático administrado.
3. URL directa del backend utilizada como origen operativo; falta formalizar un dominio de API estable.
4. Estado de presencia residente en memoria de una sola instancia.
5. No existe todavía réplica regional activa del backend ni mecanismo de failover DNS externo.

## 8. Datos críticos

Se consideran críticos:
- academias y configuración;
- usuarios/roles;
- jugadores/deportistas;
- apoderados y relaciones;
- inscripciones deportivas;
- consentimientos y privacidad;
- cobros, pagos y movimientos;
- asistencias;
- evaluaciones y estadísticas;
- torneos/partidos;
- solicitudes de nuevas disciplinas;
- configuración de licencias y suscripciones.

## 9. Inventario de secretos — solo nombres

Como mínimo deben gestionarse en el proveedor y nunca en Git:
- `SUPABASE_URL`;
- `SUPABASE_SERVICE_ROLE_KEY`;
- credenciales/tokens de WhatsApp;
- secreto de webhook WhatsApp;
- credenciales de correo/Brevo cuando aplique;
- parámetros privados de Mercado Pago cuando se migre a integración API;
- `CORS_ORIGINS` y variables operativas de rate-limit/timeout según entorno.

## 10. Criterio de actualización

Actualizar este documento cuando cambie cualquiera de los siguientes:
- proveedor de hosting;
- región;
- número de instancias;
- base de datos;
- método de autenticación;
- dominio público/API;
- proveedor de pagos;
- estrategia de backups;
- arquitectura de alta disponibilidad.
