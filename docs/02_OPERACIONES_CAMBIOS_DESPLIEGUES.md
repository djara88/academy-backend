# 02 — Operaciones, cambios y despliegues

## 1. Objetivo

Establecer un proceso repetible para modificar Syncademia sin comprometer producción.

## 2. Regla de oro

Todo cambio funcional o de infraestructura debe seguir:

`rama de trabajo → validación → PR → CI/build → merge → despliegue automático → smoke check → monitoreo`

No se debe trabajar directamente sobre `main` salvo corrección documental excepcional o emergencia expresamente justificada.

## 3. Clasificación de cambios

### Bajo riesgo
- copy/textos;
- documentación;
- estilos sin lógica;
- correcciones de accesibilidad.

### Riesgo medio
- endpoint nuevo;
- cambio de formulario;
- nueva métrica;
- modificación de plan/entitlement;
- índices no destructivos.

### Alto riesgo
- migraciones de datos;
- cambios en cobros/pagos;
- auth/RLS;
- cambios de `academia_id`/aislamiento;
- webhooks;
- backups/restauraciones;
- variables de entorno;
- infraestructura, dominios o instancias.

## 4. Checklist previo a merge

- [ ] PR describe propósito y alcance.
- [ ] No incluye secretos.
- [ ] Backend CI verde cuando aplique.
- [ ] Frontend TypeScript/Vite build verde cuando aplique.
- [ ] Migración aplicada/validada de forma atómica cuando corresponda.
- [ ] Advisor de Supabase revisado tras DDL relevante.
- [ ] No se rompen contratos actuales innecesariamente.
- [ ] Se conserva aislamiento por `academia_id`.
- [ ] Existe rollback conceptual.

## 5. Orden seguro de despliegue

Cuando frontend y backend cambian el mismo contrato:
1. desplegar backend compatible;
2. verificar Render `LIVE` y `/health`;
3. desplegar frontend;
4. verificar Vercel `READY`;
5. comprobar dominio público HTTP 200;
6. revisar 5xx y logs.

El backend debe ser compatible con la versión anterior del frontend durante la ventana de despliegue siempre que sea posible.

## 6. Migraciones Supabase

Buenas prácticas:
- usar migraciones versionadas;
- evitar DDL manual sin archivo equivalente en Git;
- preferir cambios aditivos;
- crear índices para claves foráneas y filtros frecuentes;
- validar duplicados antes de imponer UNIQUE;
- respaldar antes de migraciones destructivas;
- probar restauración cuando el cambio sea crítico.

## 7. Rollback

### Frontend
Vercel conserva despliegues anteriores. Ante incidente grave, promover/revertir a una versión conocida o revertir el commit.

### Backend
Render soporta despliegues versionados. Ante fallo de una versión:
- detener promoción si health check falla;
- revertir commit o desplegar versión estable;
- no revertir una migración destructiva sin analizar datos primero.

### Base de datos
No ejecutar rollback SQL automático sobre datos críticos sin evaluación. Para cambios aditivos, preferir corregir hacia adelante. Para corrupción o borrado, activar runbook de recuperación.

## 8. Ventanas de mantenimiento

Cambios de bajo/medio riesgo: preferentemente fuera de horario de mayor uso.

Cambios de alto riesgo:
- comunicar internamente;
- congelar cambios paralelos;
- contar con backup verificable;
- definir responsable y criterio de aborto.

## 9. Monitoreo posterior

Durante al menos 15 minutos después de cambios relevantes revisar:
- `/health`;
- respuestas 5xx;
- latencia;
- memoria/CPU;
- errores Vercel;
- logs de Auth/Postgres si hubo cambios de datos;
- integraciones WhatsApp/pagos si fueron afectadas.

## 10. Gestión de incidentes de despliegue

Severidad P1:
- login caído;
- API general caída;
- pérdida/corrupción de datos;
- aislamiento multiacademia comprometido;
- pagos duplicados;
- fuga de información.

Severidad P2:
- módulo principal degradado;
- latencia sostenida;
- integración crítica indisponible con workaround.

Severidad P3:
- error menor de interfaz;
- funcionalidad secundaria;
- problema con workaround simple.

## 11. Evidencias mínimas

Cada cambio de alto riesgo debe dejar:
- PR;
- commit de merge;
- migración si aplica;
- resultado CI;
- evidencia de deployment;
- breve nota de verificación en producción.
