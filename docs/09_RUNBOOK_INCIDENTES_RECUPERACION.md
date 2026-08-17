# 09 — Runbook de Incidentes y Recuperación

## 1. Propósito

Guía ejecutable para responder a fallas sin improvisar.

## 2. Datos de contacto — completar

- Responsable técnico: **[NOMBRE]**
- Responsable negocio: **[NOMBRE]**
- Email soporte: **[EMAIL]**
- Canal P1: **[TELÉFONO/CHAT]**
- Proveedor backend: Render
- Proveedor frontend: Vercel
- Proveedor DB/Auth: Supabase

## 3. Regla inicial

Ante cualquier P1:
1. no desplegar cambios nuevos;
2. registrar hora exacta;
3. identificar alcance;
4. preservar logs;
5. contener antes de corregir;
6. mantener una única persona coordinando decisiones.

## 4. API caída — backend

### Síntoma
Frontend carga, pero operaciones API fallan/timeout.

### Diagnóstico
1. revisar `/health`;
2. revisar estado/deploy Render;
3. revisar logs y 5xx;
4. revisar CPU/RAM/latencia;
5. revisar conectividad Supabase.

### Con HA Nivel 1
- comprobar si una instancia sigue sana;
- Render debería retirar la instancia no saludable automáticamente;
- si ambas fallan, tratar como falla del servicio/deploy o dependencia común.

### Acción
- rollback del último deploy si coincide temporalmente;
- reinicio/redeploy solo si existe evidencia;
- no borrar cache/datos como primera medida.

## 5. Frontend caído

1. revisar deployment Vercel;
2. revisar dominio/alias;
3. comprobar último deployment READY;
4. promover/revertir versión anterior si el fallo es de build/runtime;
5. verificar que la API siga accesible.

## 6. Base de datos/Supabase indisponible

1. verificar estado del proyecto;
2. revisar logs Postgres/API/Auth;
3. identificar si es caída o corrupción;
4. si solo es indisponibilidad, evitar cambios destructivos;
5. si existe corrupción/borrado, activar restauración según política 03.

Nunca restaurar una base sobre producción sin:
- identificar punto de recuperación;
- estimar pérdida de datos;
- conservar evidencia/backup actual si es posible;
- aprobación del responsable.

## 7. Corrupción o borrado de datos

1. detener procesos que puedan seguir escribiendo el dato defectuoso;
2. determinar tablas/academias afectadas;
3. obtener timestamp del primer evento;
4. evaluar recuperación selectiva vs restauración completa;
5. probar restauración en entorno aislado;
6. reconciliar transacciones posteriores si existe RPO > 0;
7. reabrir servicio después de validación funcional.

## 8. Error de aislamiento multiacademia

Severidad automática: **P1 de seguridad**.

1. deshabilitar endpoint/función afectada si es necesario;
2. preservar request IDs/logs;
3. identificar academias y datos expuestos;
4. corregir filtro/autorización/RLS;
5. ejecutar pruebas cruzadas Academia A ↔ B;
6. analizar deber de notificación conforme a normativa/contrato;
7. post-mortem obligatorio.

## 9. Pagos o cobros duplicados

1. detener job/endpoint que genera duplicación;
2. no eliminar filas sin conservar trazabilidad;
3. identificar clave idempotente/periodo/inscripción;
4. determinar si hubo cobro monetario real o solo registro interno;
5. corregir lógica e imponer protección de base cuando corresponda;
6. reconciliar manualmente con evidencia;
7. comunicar a clientes afectados si aplica.

## 10. WhatsApp/webhook caído

1. verificar endpoint de webhook;
2. revisar secreto/configuración sin exponerlo;
3. validar logs de recepción;
4. distinguir fallo de proveedor vs Syncademia;
5. mantener alternativa manual si la operación lo requiere;
6. reintentar mensajes solo con control para evitar duplicados.

## 11. Credencial/secret expuesto

Severidad: P1.

1. revocar/rotar secreto inmediatamente;
2. revisar historial/logs desde ventana de exposición;
3. actualizar variables en proveedor;
4. redeploy si es necesario;
5. verificar que el secreto no esté en Git, artefactos, logs o documentación;
6. invalidar sesiones/tokens relacionados si aplica;
7. evaluar impacto de datos.

## 12. Failover regional del backend — futuro Nivel 2

Cuando exista standby:
1. confirmar caída primaria;
2. balanceador externo debe dirigir al standby;
3. validar `/health` standby;
4. validar login;
5. validar lectura/escritura de prueba controlada;
6. revisar latencia por distancia a Supabase Canadá;
7. comunicar estado;
8. no retornar al primario hasta que sea estable.

## 13. Restauración de backup — checklist

- [ ] backup seleccionado identificado por fecha/hora;
- [ ] checksum/archivo íntegro;
- [ ] entorno destino aislado;
- [ ] esquema restaurado;
- [ ] conteos de academias/usuarios/jugadores/cobros revisados;
- [ ] login de usuario QA;
- [ ] matrícula/cobros/asistencia/evaluación validados;
- [ ] permisos/RLS comprobados;
- [ ] decisión de promoción a producción registrada.

## 14. Post-mortem

Para P1/P2 generar dentro de 3 días hábiles:
- resumen ejecutivo;
- línea de tiempo;
- impacto;
- causa raíz;
- por qué no se detectó antes;
- mitigación;
- acción correctiva con responsable/fecha;
- prueba que demuestra que no se repite.

## 15. Simulacros

- restauración DB: trimestral;
- caída de backend/health check: semestral o tras cambio HA;
- secreto expuesto tabletop: anual;
- aislamiento multiacademia: test automatizado por release mayor.
