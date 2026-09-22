# Syncademia — Paquete documental v1

**Estado:** borrador controlado  
**Fecha base:** 16-08-2026  
**Propietario:** SMProWeb / Syncademia  
**Objetivo:** disponer de documentación interna y externa suficiente para operar, vender, soportar y recuperar Syncademia de forma profesional.

## Clasificación

| Documento | Uso | Audiencia | Estado |
|---|---|---|---|
| 01 Arquitectura e inventario | Interno | TI / Dirección / auditoría | Vigente |
| 02 Operaciones, cambios y despliegues | Interno | TI / Desarrollo | Vigente |
| 03 Backup, alta disponibilidad y DR | Interno | TI / Dirección | Plan de implementación |
| 04 Seguridad, privacidad e incidentes | Interno | TI / Dirección / auditoría | Vigente con acciones pendientes |
| 05 Manual de usuarios | Externo | Directores / profesores / apoderados | Borrador publicable |
| 06 SLA, soporte y continuidad | Externo | Clientes | Borrador contractual |
| 07 Términos de servicio | Externo | Clientes | Borrador legal; requiere revisión profesional |
| 08 Política de privacidad y DPA | Externo | Clientes / titulares de datos | Borrador legal; requiere revisión profesional |
| 09 Runbook de incidentes y recuperación | Interno | TI / Operaciones | Vigente |

## Principios documentales

1. La documentación debe reflejar producción, no una arquitectura aspiracional.
2. Ningún documento debe contener claves, tokens, secretos, passwords ni service-role keys.
3. Toda modificación relevante de arquitectura debe actualizar al menos `01`, `03` y `09`.
4. Términos de servicio, privacidad y DPA deben ser revisados por abogado antes de publicación definitiva.
5. Los documentos externos no deben prometer niveles de disponibilidad que la infraestructura aún no soporte.

## Estado de producción resumido

- Frontend: React + TypeScript + Vite desplegado en Vercel.
- Backend: Node.js + Express desplegado en Render.
- Base de datos y Auth: Supabase/PostgreSQL.
- Código: repositorios privados GitHub `academy-frontend` y `academy-backend`.
- Arquitectura SaaS multiacademia, multisede, multirrama y multideporte.
- Backend actual: una sola instancia Render Free; **no constituye alta disponibilidad**.
- Supabase actual: plan Free; **no dispone de backups automáticos administrados**.

## Prioridades de cierre antes de venta masiva

1. Backend siempre encendido en instancia pagada.
2. Dos instancias backend con health check y balanceo automático.
3. Migrar presencia/estado efímero compartido fuera de memoria local antes de escalar horizontalmente.
4. Supabase Pro para backup diario + copia lógica cifrada fuera del proveedor.
5. Prueba trimestral de restauración.
6. Definir dominio productivo estable para frontend y API.
7. Revisión legal de documentos 07 y 08.
8. Definir contacto formal de soporte, razón social, RUT, domicilio y canal de privacidad.
