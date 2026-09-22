# 06 — SLA, Soporte y Continuidad — Borrador contractual

> Documento externo. No publicar como compromiso contractual definitivo hasta completar la infraestructura HA mínima y revisión legal/comercial.

## 1. Objeto

Definir niveles de atención, disponibilidad objetivo, clasificación de incidentes y responsabilidades entre Syncademia y la academia cliente.

## 2. Horario de soporte propuesto

- Soporte estándar: **[LUNES A VIERNES, HORARIO]**.
- Canal: **[EMAIL SOPORTE / PORTAL]**.
- Incidentes críticos P1: **[CANAL DE EMERGENCIA]**.

## 3. Severidades

### P1 — Crítico
Servicio general inaccesible, imposibilidad de autenticación para la mayoría de usuarios, pérdida/corrupción confirmada de datos, problema de aislamiento entre academias o falla general de cobros.

Objetivo de primera respuesta propuesto: **≤ 60 minutos** dentro de cobertura acordada.

### P2 — Alto
Función principal indisponible para un grupo relevante, degradación severa o integración crítica sin funcionamiento.

Objetivo de primera respuesta: **≤ 4 horas hábiles**.

### P3 — Medio
Error funcional acotado con workaround.

Objetivo: **≤ 1 día hábil**.

### P4 — Bajo / solicitud
Consulta, mejora, configuración o error cosmético.

Objetivo: **≤ 2 días hábiles**.

## 4. Disponibilidad

### Estado actual
La infraestructura actual no debe prometer un SLA contractual de alta disponibilidad mientras el backend permanezca en una sola instancia Free.

### Objetivo posterior a HA Nivel 1
Una vez implementadas dos instancias pagadas, health check y backup administrado, se podrá definir contractualmente un objetivo de disponibilidad mensual, por ejemplo 99,5% o superior, sujeto a validación de operación real.

**No publicar 99,9% hasta medir y demostrar capacidad sostenida.**

## 5. Exclusiones habituales

No computarán como incumplimiento cuando el contrato así lo establezca:
- mantenimientos programados comunicados;
- fuerza mayor;
- indisponibilidad de Internet del cliente;
- fallas de proveedores externos fuera del control razonable, con gestión activa de contingencia;
- acciones del cliente que vulneren seguridad o configuración;
- servicios beta identificados como tales.

## 6. Mantenimiento programado

Objetivo:
- preferentemente fuera de horario pico;
- aviso de al menos **[24/48] horas** cuando exista impacto esperado;
- emergencias de seguridad pueden ejecutarse sin aviso previo cuando sea necesario para proteger datos.

## 7. Backup y recuperación

Después de implementar la política de producción:
- backup administrado de base de datos diario;
- copia lógica cifrada off-site;
- restauración probada trimestralmente;
- RPO/RTO definidos en documento interno 03.

El cliente debe comprender que backup no equivale a historial ilimitado ni permite recuperar cualquier cambio individual sin costo/impacto.

## 8. Responsabilidad del cliente

La academia cliente debe:
- designar administradores autorizados;
- proteger credenciales;
- mantener datos correctos;
- obtener consentimientos/bases legales que le correspondan;
- informar bajas de personal;
- evitar compartir datos fuera de los canales autorizados;
- reportar incidentes oportunamente.

## 9. Soporte incluido por plan

Propuesta comercial:
- Formación: soporte estándar;
- Competencia: soporte prioritario;
- Alto Rendimiento: soporte preferencial y acompañamiento de configuración;
- Apoderados PRO: soporte de la funcionalidad para la administración de la academia; el soporte directo masivo a cada apoderado debe definirse comercialmente para evitar carga no controlada.

## 10. Créditos/compensación

No se establecen créditos automáticos en este borrador. Cualquier esquema de compensación por SLA debe definirse cuando exista infraestructura y telemetría suficiente para medir disponibilidad objetivamente.

## 11. Evidencia

La fuente de medición debe ser la monitorización del servicio y registros del proveedor, no únicamente reportes individuales del usuario.
