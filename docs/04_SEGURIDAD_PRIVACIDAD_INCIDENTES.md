# 04 — Política interna de Seguridad, Privacidad e Incidentes

## 1. Alcance

Aplica a código, infraestructura, base de datos, usuarios administrativos, clientes, apoderados, deportistas y terceros que procesen información vinculada a Syncademia.

## 2. Principios

1. mínimo privilegio;
2. aislamiento por academia;
3. autenticación obligatoria salvo endpoints públicos expresos;
4. secreto fuera de Git;
5. trazabilidad para operaciones críticas;
6. cifrado en tránsito;
7. minimización de datos;
8. privacidad desde el diseño;
9. respuesta rápida ante incidentes;
10. revisión continua de dependencias, RLS y permisos.

## 3. Clasificación de información

### Crítica / restringida
- service-role keys y tokens;
- secretos de webhooks;
- credenciales de proveedores;
- datos médicos/emergencia;
- documentos de identidad y datos sensibles;
- información financiera y pagos.

### Confidencial
- datos personales de jugadores/apoderados/profesores;
- asistencias;
- evaluaciones deportivas;
- comunicaciones;
- datos internos de academias.

### Interna
- documentación técnica;
- métricas agregadas;
- roadmap;
- procesos internos.

### Pública
- Home comercial;
- precios publicados;
- documentación pública expresamente aprobada.

## 4. Identidad y acceso

- Cada usuario debe usar cuenta individual.
- Está prohibido compartir credenciales administrativas.
- Superadmin debe mantener MFA.
- Accesos se asignan por rol y contexto de academia.
- Credenciales de proveedores deben rotarse ante sospecha de exposición.
- Usuarios desvinculados deben desactivarse sin demora.

## 5. Seguridad del backend

Controles vigentes incluyen headers defensivos, CORS controlado, rate-limit, JWT, autorización por rol/feature, timeouts y graceful shutdown.

Requisitos operativos:
- no exponer stack traces al cliente;
- validar payloads y pertenencia a `academia_id`;
- no aceptar IDs de otra academia como autorización implícita;
- endpoints GET no deben generar efectos financieros;
- operaciones de pago/matrícula deben ser idempotentes;
- health check no debe exponer secretos.

## 6. Supabase y base de datos

- Service Role solo en backend.
- Nunca usar Service Role en frontend.
- RLS debe proteger accesos directos de `authenticated` cuando corresponda.
- Funciones `SECURITY DEFINER` sensibles deben mantenerse fuera del esquema público expuesto, salvo justificación documentada.
- Toda nueva FK de alto uso debe evaluarse para índice.
- Advisor de seguridad/rendimiento se revisa después de DDL relevante.

## 7. Datos de menores

Syncademia trata información asociada a menores de edad. Reglas internas:
- recolectar solo lo necesario;
- vincular apoderado/tutor;
- registrar consentimientos cuando corresponda;
- restringir datos médicos/emergencia;
- no usar información de menores con fines publicitarios ajenos al servicio sin base legal/consentimiento aplicable;
- atender rectificación/eliminación conforme a normativa y obligaciones de conservación.

## 8. Marco chileno

A la fecha de este documento, la Ley 19.628 sigue vigente en su versión actual hasta el 30-11-2026. La Ley 21.719 entra en vigencia el 01-12-2026 y fortalece derechos, obligaciones de responsables/encargados y la institucionalidad de protección de datos.

Syncademia debe llegar al 01-12-2026 con:
- inventario de tratamientos;
- roles responsable/encargado definidos contractualmente;
- política de privacidad actualizada;
- canal para derechos de titulares;
- registro de incidentes;
- contratos con subencargados/proveedores;
- medidas técnicas y organizativas documentadas.

## 9. Gestión de vulnerabilidades

Periodicidad recomendada:
- dependencias: en cada CI/build relevante y revisión mensual;
- Supabase Advisors: tras DDL y mensual;
- revisión de permisos/RLS: trimestral;
- prueba E2E multiacademia: por release mayor;
- stress test: previo a cambios relevantes de capacidad.

## 10. Incidentes de seguridad

### P1 — crítico
- acceso cruzado entre academias;
- exfiltración o publicación de datos;
- credencial Service Role expuesta;
- pago duplicado masivo;
- borrado/corrupción de información;
- toma de control de cuenta privilegiada.

### P2 — alto
- indisponibilidad prolongada;
- webhook abusado;
- fuga limitada o con alcance no confirmado;
- degradación que afecta operación crítica.

### P3 — medio/bajo
- error localizado sin exposición de datos;
- vulnerabilidad sin explotación conocida y con mitigación inmediata.

## 11. Proceso de respuesta

1. detectar y registrar hora;
2. clasificar severidad;
3. contener;
4. preservar logs/evidencia;
5. erradicar causa;
6. recuperar servicio;
7. validar integridad;
8. determinar necesidad de comunicación al cliente/titular/autoridad según normativa aplicable;
9. post-mortem;
10. acción preventiva verificable.

## 12. Proveedores/subencargados relevantes

Inventario base:
- Vercel — hosting frontend/CDN;
- Render — backend compute;
- Supabase — PostgreSQL/Auth/Realtime;
- GitHub — repositorio/CI;
- Mercado Pago — pagos cuando corresponda;
- proveedor de WhatsApp/Meta según integración vigente;
- Brevo/correo cuando se utilice.

Para cada proveedor mantener: finalidad, tipo de datos, región conocida, contrato/DPA disponible, contacto y plan de salida.

## 13. Retención

La retención definitiva debe alinearse con contrato, finalidad y obligaciones legales. Como base:
- no conservar datos indefinidamente sin propósito;
- eliminar o anonimizar cuentas cerradas una vez cumplidas obligaciones;
- backups deben expirar mediante política de retención;
- logs deben tener retención conocida y proporcional.

## 14. Acciones pendientes

- [ ] formalizar razón social y datos de contacto de privacidad;
- [ ] revisar términos/DPA con asesor legal;
- [ ] migrar Supabase a plan con backups automáticos;
- [ ] definir backup off-site cifrado;
- [ ] mantener registro de subencargados;
- [ ] revisar licencia del código: `package.json` backend declara actualmente `MIT`; decidir política de propiedad intelectual antes de una eventual transferencia/venta del software.
