# 03 — Política de Backup, Alta Disponibilidad y Disaster Recovery

## 1. Objetivo

Evitar que una falla de servidor, despliegue o pérdida de datos deje Syncademia fuera de servicio por un periodo inaceptable.

## 2. Situación actual

### Backend
- Render Free.
- Una sola instancia.
- Región Oregon.
- Health check `/health` activo.
- Free puede reiniciarse y entrar en sleep; no permite escalar más allá de una instancia.
- Por definición, hoy existe un punto único de falla de cómputo.

### Base de datos
- Supabase Free.
- Región Canadá Central.
- No dispone de backup automático administrado en el plan actual.

### Frontend
- Vercel; la capa estática/global presenta menor riesgo de falla de una única VM que el backend actual.

## 3. Objetivos propuestos

### Fase comercial inicial
- Backend RTO ante falla de una instancia: **< 60 segundos**.
- Backend RPO: **0** (el backend es stateless; los datos viven en Supabase).
- Base de datos RPO objetivo con backup administrado: **≤ 24 horas**.
- Base de datos RTO inicial: **≤ 4 horas**.

### Fase de crecimiento
- Backend RTO: **< 30 segundos**.
- Base de datos RPO: evaluar PITR si el costo/riesgo justifica recuperación a segundos/minutos.
- DR regional: **≤ 15 minutos** con standby y failover externo.

## 4. Alta disponibilidad recomendada — Nivel 1

### Diseño

`Internet → Render Load Balancer → Instancia A + Instancia B → Supabase`

Requisitos:
1. cambiar el servicio backend desde Free a instancia pagada;
2. ejecutar **2 instancias** del mismo servicio;
3. mantener `/health`;
4. no usar disco persistente local;
5. mantener backend stateless;
6. mover la presencia global desde memoria local a un store compartido antes de activar dos instancias.

### Comportamiento esperado
Render balancea tráfico entre instancias. Si una instancia falla health checks consecutivos, deja de enviarle tráfico y continúa utilizando la instancia sana mientras reinicia la defectuosa.

Esto cubre:
- crash de Node;
- falla de VM/nodo;
- deploy defectuoso que no pasa health check;
- reinicio puntual de una instancia.

No cubre por sí solo una caída completa de la región de Render.

## 5. Estado compartido antes de escalar

La presencia/concurrencia se almacena actualmente en memoria de proceso. Con dos instancias, cada una vería solo sus propios usuarios.

Antes del escalamiento horizontal:
- mover presencia a Redis/Render Key Value u otro store compartido;
- TTL sugerido: 90 segundos por heartbeat;
- mantener únicamente IDs/rol/academia necesarios para la métrica;
- no convertir Redis en fuente de verdad de datos críticos.

Los caches de mantenimiento de corta duración pueden seguir siendo locales si una ejecución duplicada sigue siendo segura/idempotente.

## 6. Alta disponibilidad — Nivel 2 / DR regional

### Diseño objetivo

`DNS/LB con health check`
- Primary: Render Oregon.
- Standby: Render Virginia u Ohio.
- Ambos ejecutan el mismo commit y variables equivalentes.
- Ambos apuntan a la misma base Supabase mientras esta se encuentre disponible.

El balanceador externo debe comprobar `/health` y enviar tráfico al standby cuando el origen primario no responda.

### Limitación
Un segundo backend regional no elimina el riesgo de indisponibilidad de Supabase. Para DR completo de datos se necesita estrategia de recuperación de base de datos independiente.

## 7. Backup de Supabase

### Recomendación mínima de producción
Migrar a Supabase Pro.

Beneficios relevantes:
- backup diario administrado;
- retención de 7 días;
- proyecto no se pausa por inactividad;
- mayor capacidad y soporte.

### Segunda copia fuera del proveedor
Mantener además un backup lógico cifrado fuera de Supabase.

Frecuencia propuesta:
- piloto: diario;
- operación estable: diario + copia semanal de retención ampliada;
- antes de migraciones críticas: backup ad-hoc.

Retención propuesta:
- diarios: 14 días;
- semanales: 8 semanas;
- mensuales: 12 meses.

Destino recomendado: almacenamiento objeto cifrado de otro proveedor (S3/R2/B2 equivalente), con bucket privado, MFA y lifecycle.

## 8. Qué respaldar

Obligatorio:
- esquema PostgreSQL;
- datos;
- funciones SQL/RPC;
- políticas RLS;
- migraciones Git;
- configuración de Auth exportable/documentada;
- configuración de integraciones y nombres de secretos (nunca valores en documentos);
- cualquier archivo/objeto externo que se incorpore en el futuro.

Código fuente no requiere backup separado diario si GitHub está íntegro, pero se debe mantener repositorio privado, MFA y al menos un segundo administrador/plan de recuperación de cuenta.

## 9. Cifrado y manejo de backups

- cifrar en tránsito (TLS);
- cifrar en reposo;
- backup lógico adicional debe cifrarse antes de abandonar el runner;
- secretos de cifrado fuera del repositorio;
- acceso mínimo necesario;
- registrar restauraciones y descargas.

## 10. Prueba de restauración

Un backup no se considera válido hasta haber sido restaurado.

Frecuencia:
- primera prueba: antes de incorporar clientes masivos;
- luego: trimestral;
- adicionalmente: después de cambios relevantes en estrategia de backup.

Prueba mínima:
1. crear entorno temporal aislado;
2. restaurar último backup;
3. validar tablas y conteos;
4. validar login de prueba;
5. validar academia, alumno, inscripción, cobros, asistencia y evaluación;
6. destruir entorno temporal;
7. registrar duración y hallazgos.

## 11. Failover operativo

### Falla de una instancia backend
Automático con 2 instancias + health check. No requiere cambio DNS.

### Falla completa del servicio/región primaria
1. health check externo detecta caída;
2. balanceador dirige al standby;
3. TI valida login y flujo crítico;
4. se congela despliegue hasta estabilización;
5. cuando el primario vuelve, retorno controlado.

### Falla de base de datos
1. declarar P1;
2. detener escrituras si existe riesgo de inconsistencia;
3. determinar si es disponibilidad o corrupción;
4. usar recuperación administrada/backup según caso;
5. verificar integridad antes de reabrir.

## 12. Orden de implementación recomendado

### Prioridad A — obligatoria antes de crecimiento
1. Render backend pagado y always-on.
2. Dos instancias del backend.
3. Presencia en store compartido.
4. Supabase Pro.
5. Backup lógico cifrado off-provider.
6. Primera restauración documentada.

### Prioridad B — cuando existan clientes y MRR suficiente
7. Dominio de API propio (`api.<dominio>`).
8. Segundo backend regional warm standby.
9. Load balancer/DNS con health checks.
10. Evaluar PITR según exposición financiera y RPO requerido.

## 13. Dependencias y costos

- Render Free no soporta múltiples instancias y Render indica que Free no es apropiado para producción.
- Dos instancias implican costo de compute por cada instancia.
- Supabase Pro parte desde USD 25/mes e incluye backup diario de 7 días según tarifa vigente al elaborar este documento.
- PITR es adicional y tiene costo considerable; no se recomienda contratarlo sin justificar RPO.

## 14. Decisión pendiente de Dirección

Antes de ejecutar cambios con costo se debe aprobar:
- tipo de instancia Render;
- 2 instancias mínimas;
- Supabase Pro;
- proveedor de almacenamiento off-site;
- dominio definitivo;
- si se requiere DR regional desde el lanzamiento o después de alcanzar un umbral de clientes.
