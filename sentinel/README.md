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
- Puede usar OpenAI para recomendaciones técnicas **solo** ante transiciones/incidentes o en el informe semanal.
- Si la API de IA no está configurada o falla, usa reglas determinísticas y continúa funcionando.

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

Ejecuta el chequeo y agrega un informe al issue #81.

Los comentarios del propio bot no vuelven a disparar el workflow, por lo que no existe un bucle automático.

## Costos

La monitorización base no requiere servicios nuevos ni infraestructura adicional: usa GitHub Actions y endpoints existentes.

La IA es opcional y solo consume API cuando:

1. cambia el estado observado;
2. existe un incidente/degradación;
3. se genera el informe semanal.

Esto reduce el consumo frente a invocar un modelo en cada chequeo sano.

## Secrets opcionales

### `LESTRA_SENTINEL_OPENAI_API_KEY`

API key dedicada exclusivamente a Sentinel. Permite recomendaciones generadas por modelo.

**No reutilizar** claves de Supabase, Render, Vercel, Mercado Pago ni JWT.

### `LESTRA_SENTINEL_GITHUB_READ_TOKEN`

Token de GitHub de solo lectura con acceso a:

- `djara88/academy-backend`
- `djara88/academy-frontend`

Sirve únicamente para que Sentinel pueda consultar CI del frontend privado. Sin este token, el agente sigue funcionando y marca ese dato como `No disponible`.

## Variable opcional

### `LESTRA_SENTINEL_OPENAI_MODEL`

Modelo usado por Sentinel. Si no se define, el script usa `gpt-5-mini` como valor por defecto y vuelve a reglas determinísticas si la llamada no está disponible.

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