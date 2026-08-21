# Lestra Sentinel

Agente operativo de Lestra en modo **Observer**.

## Qué hace en v1

- Comprueba disponibilidad de:
  - `https://www.lestra.app`
  - `https://deportivo.lestra.app`
  - `https://academy-backend-kqsv.onrender.com/health`
- Revisa el último `Backend CI` del repositorio actual.
- Intenta leer `Frontend CI` si existe un token dedicado con permiso de lectura sobre `academy-frontend`.
- Clasifica el estado como `HEALTHY`, `WARNING` o `CRITICAL`.
- Mantiene un estado consolidado en el issue #81.
- Registra transiciones e incidentes en el issue #82.
- Genera un informe semanal en el issue #81.
- Puede usar **Vercel AI Gateway** para recomendaciones técnicas solo ante transiciones/incidentes o en el informe semanal.
- Si AI Gateway no está configurado, no tiene crédito, está limitado o falla, Sentinel usa reglas determinísticas y continúa funcionando.

## Qué NO hace

- No modifica Supabase.
- No usa `SUPABASE_SERVICE_ROLE_KEY`.
- No cambia variables de entorno.
- No dispara deploys.
- No cambia roles ni usuarios.
- No toca pagos.
- No fusiona PRs.
- No ejecuta SQL.
- No almacena PII ni secretos.
- No usa una API de OpenAI directa como fallback.
- No compra créditos ni habilita recargas automáticas.

## Programación

- Monitor: cada 30 minutos.
- Informe semanal: lunes, 13:00 UTC (GitHub Actions usa UTC).
- Ambos workflows permiten ejecución manual desde Actions.

## Comandos por comentario

En el issue **#81 Lestra Sentinel — Estado operativo**, únicamente el usuario GitHub `djara88` puede activar comandos que comiencen por `/sentinel`.

### Revisar ahora

```text
/sentinel revisar
```

Ejecuta inmediatamente el mismo chequeo seguro del monitor y actualiza el estado del issue #81.

### Generar informe ahora

```text
/sentinel informe
```

Ejecuta el chequeo y agrega un informe al issue #81. Si AI Gateway está conectado, este modo puede utilizar IA.

Los comentarios del propio bot no vuelven a disparar el workflow, por lo que no existe un bucle automático.

## Costos y política cero gasto

La monitorización base no requiere servicios nuevos ni infraestructura adicional: usa GitHub Actions y endpoints existentes.

Vercel AI Gateway ofrece crédito gratuito mensual al equipo. Sentinel está diseñado para aprovecharlo sin transformar el monitor en un consumidor permanente de tokens:

1. un chequeo sano normal no llama a ningún modelo;
2. IA solo se intenta cuando cambia el estado, existe una degradación o se genera el informe semanal;
3. si Gateway responde `402` por presupuesto/crédito agotado, Sentinel vuelve inmediatamente a reglas locales;
4. no existe fallback a una API de pago directa;
5. la recarga automática debe permanecer desactivada en Vercel.

El objetivo durante la etapa pre-comercial es mantener **costo incremental de IA = $0**.

## Secrets opcionales

### `LESTRA_SENTINEL_AI_GATEWAY_KEY`

API key dedicada de **Vercel AI Gateway** para Sentinel.

Debe crearse con presupuesto limitado y sin auto top-up. No reutilizar claves de Supabase, Render, Mercado Pago, JWT ni otros servicios.

### `LESTRA_SENTINEL_GITHUB_READ_TOKEN`

Token de GitHub de solo lectura con acceso a:

- `djara88/academy-backend`
- `djara88/academy-frontend`

Sirve únicamente para que Sentinel pueda consultar CI del frontend privado. Sin este token, el agente sigue funcionando y marca ese dato como `No disponible`.

## Variable opcional

### `LESTRA_SENTINEL_AI_MODEL`

Modelo usado por Sentinel a través de Vercel AI Gateway.

Si no se define, el script usa:

```text
google/gemini-3.5-flash-lite
```

Es un modelo ligero apropiado para clasificación, resumen y diagnóstico operacional. La variable permite cambiarlo sin modificar código si Vercel cambia el catálogo.

## Memoria durable

Sentinel usa GitHub Issues para evitar una base de datos adicional:

- **#81 Estado operativo:** snapshot actual + marcador interno de estado.
- **#82 Memoria operativa:** comentarios append-only cuando cambia un estado relevante.

La memoria solo guarda:

- síntoma técnico;
- transición;
- severidad;
- recomendación;
- resultado observado.

Nunca debe guardar PII, tokens ni credenciales.

## Evolución futura

La fase siguiente puede incorporar, con credenciales dedicadas de solo lectura:

- métricas de Render;
- deployment metadata y runtime errors de Vercel;
- una vista agregada/segura de Supabase sin acceso a datos personales;
- alertas WhatsApp/correo;
- creación automática de ramas/PRs para correcciones, siempre sin auto-merge.

La política de seguridad está versionada en `sentinel/instructions.md`.
