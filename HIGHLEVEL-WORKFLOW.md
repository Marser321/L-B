# HighLevel: calendario, pipeline y notificaciones web

El sitio mantiene su configurador propio. El servidor crea o actualiza el contacto, registra una oportunidad por `Submission ID`, consulta la disponibilidad real y crea una cita confirmada en **Website Bookings — Mobile Team**.

Los datos personales usan los campos estándar del contacto. Servicio, vehículo, extras, dirección operativa, estimado y datos de la cita se guardan en campos de oportunidad para conservar cada reserva por separado.

Una reserva puede incluir **varios vehículos/servicios en una sola visita** (carrito). Todos comparten fecha, franja y dirección, y generan **una sola cita y una sola oportunidad**. El desglose por vehículo queda en `Website Quote - Items` (una línea numerada por servicio) y el total de líneas en `Website Quote - Item Count`; los campos de vehículo muestran los valores de todas las líneas separados por `; `.

## Horarios, duración y disponibilidad

El sitio **ya no ofrece franjas fijas** (mañana/tarde/noche). En su lugar calcula la **duración real de la visita** y ofrece **horas de inicio en una grilla de 30 minutos** entre las **8:00 y las 18:00**, mostrando solo las que terminan antes del cierre.

- Duración por categoría (servicio + buffer de traslado): autos 60+30, camiones 90+30, náutica 120+60, jet ski 120+60, casa móvil 90+30, carrito de golf 30+30, ATV 30+30, entradas/patios 120+30. La corrección/protección de pintura sigue reservando el **día completo (8–18)**.
- Un carrito con varios vehículos suma las duraciones (se lavan uno tras otro) y toma **un solo depósito**, el mayor de las líneas.
- **Antelación:** 1 hora para reservas normales; **48 horas para membresías** (cualquier paquete `-2x`/`-4x`/membresía). El sitio bloquea las fechas que no cumplen; la política de 48h de membresía se mantiene además en los workflows de GHL.
- **Capacidad simultánea:** el backend consulta la agenda de cada crew (variable `GHL_CREW_USER_IDS`, lista de IDs separada por comas) y ofrece una hora si **cualquiera** está libre; asigna la cita al primer crew disponible. Hoy hay 2 crews activos aunque existan 4 usuarios `Camioneta` en la subcuenta — agregar un tercero/cuarto es solo añadir su ID a la variable, sin cambiar código.
- El endpoint crea la cita con `ignoreFreeSlotValidation`, porque la grilla de 30 min y la duración variable las gobierna el sitio, no las reglas nativas del calendario. Mantén el calendario abierto de lunes a sábado 8–18 (o más amplio) para no recortar la grilla.

## Depósito

Cada reserva pide un **depósito para confirmar**: **$30** para unidades chicas (autos, carrito de golf, ATV, jet ski) y **$50** para grandes (camiones, náutica, casa móvil, entradas/patios, pintura). El sitio lo muestra en el resumen y lo guarda en `Website Quote - Deposit Due`.

### Fase B — cobro online del depósito (`GHL_DEPOSIT_PAYMENTS`)

Con la variable `GHL_DEPOSIT_PAYMENTS=on`, justo después de confirmar la cita el sitio crea una **factura text2pay de HighLevel** (`POST /invoices/text2pay`) por el monto del depósito, atada al contacto, y muestra en la pantalla de éxito un botón **"Pay $X deposit"** que abre la página de pago alojada por HighLevel/Stripe (`invoiceUrl` de la respuesta). El modelo es **CONFIRM-THEN-PAY**: la cita ya está confirmada antes de intentar cobrar, así que un fallo al crear el link de pago nunca puede convertir una reserva confirmada en un error — solo se pierde el botón, y el depósito se sigue pudiendo cobrar a mano desde el CRM. Ver detalles, endpoint exacto, nivel de confianza y decisiones pendientes en `PHASE-B-DECISIONS.md`.

- `GHL_DEPOSIT_PAYMENTS=on` activa la función completa (llamada a la API de pagos, campos nuevos en la oportunidad, botón en el sitio). Sin definir (o cualquier otro valor) el comportamiento es **idéntico byte a byte** a la Fase A.
- `GHL_DEPOSIT_LIVE_MODE=true` cobra en modo Stripe LIVE; cualquier otro valor (incluido sin definir) usa modo TEST, para que activar el flag nunca mueva dinero real por accidente.
- Campos nuevos de oportunidad: `Website Quote - Deposit Status` (queda en `unpaid` al crear el link) y `Website Quote - Deposit Link` (URL de pago). Solo se exigen en HighLevel cuando el flag está en `on`; si el flag está apagado, el sitio nunca los necesita.
- Reintentos de un mismo `submissionId` (duplicados) **no** generan una segunda factura: el link de pago solo se crea la primera vez que la reserva pasa a confirmada.
- Si la API de pagos falla (o responde 5xx/timeout), el error queda en los logs (`[quote] deposit payment failed …`) y la reserva sigue devolviendo 200 confirmado, sin `depositUrl`. **El cobro manual desde el CRM sigue siendo el respaldo.**

> ⚠️ Antes del deploy hay que **volver a ejecutar `node scripts/setup-ghl.mjs`** para crear los campos nuevos `Website Quote - Items`, `Website Quote - Item Count`, `Website Quote - Deposit Due` y `Website Quote - Service Duration`. Si faltan, el endpoint responde 503 (`custom fields are not configured`). Si además se va a activar `GHL_DEPOSIT_PAYMENTS=on`, el script también debe crear `Website Quote - Deposit Status` y `Website Quote - Deposit Link` — vuelve a ejecutarlo (o créalos a mano) antes de prender el flag.

## Permisos del Private Integration Token

El token de subcuenta necesita, como mínimo:

- `contacts.readonly` y `contacts.write`
- `opportunities.readonly` y `opportunities.write`
- `locations/customFields.readonly` y `locations/customFields.write`
- `calendars.readonly`
- `calendars/events.readonly` y `calendars/events.write`
- `calendars.write` solamente cuando el script de setup deba crear el calendario
- `invoices.write` — solo necesario si se activa `GHL_DEPOSIT_PAYMENTS=on` (Fase B, crea la factura text2pay del depósito)

## Preparación de la subcuenta

1. En **Opportunities → Pipelines**, confirma que `Pipeline de Servicios` tenga las etapas `Pendiente de Información` y `Cita Confirmada`.
2. Define `GHL_PRIVATE_TOKEN`, `GHL_LOCATION_ID` y `GHL_ASSIGNED_USER_ID` en una sesión local segura.
3. Ejecuta `node scripts/setup-ghl.mjs`.
4. El script crea los campos faltantes, localiza o crea `Website Bookings — Mobile Team` y muestra los IDs que deben guardarse en Vercel.
5. Revisa el calendario: lunes a sábado, `America/New_York`, cubriendo al menos 8am–6pm. La duración y la grilla de horas las gobierna el sitio (`ignoreFreeSlotValidation`), así que el `slotDuration`/buffer nativos ya no recortan la disponibilidad; mantén 60 días de ventana.
6. Configura en Vercel Production todas las variables listadas en `.env.example` y despliega nuevamente.

Los cierres, vacaciones y aperturas excepcionales se administran en HighLevel. No se deben duplicar como reglas estáticas en el sitio.

## Confirmaciones para el cliente

En **Calendar Settings → Website Bookings — Mobile Team → Notifications** configura:

- confirmación inmediata por SMS;
- confirmación inmediata por email cuando el contacto tenga email;
- recordatorio por SMS/email 24 horas antes;
- recordatorio por SMS 2 horas antes;
- enlaces de reprogramación y cancelación en los mensajes correspondientes.

El título debe identificar el servicio móvil y el cuerpo debe incluir contacto, fecha, franja, dirección y enlace para administrar la cita. Haz una reserva de prueba para comprobar que las notificaciones se envían una sola vez.

## Workflow interno

1. Abre **Automation → Workflows → Create Workflow → Start from scratch**.
2. Usa el nombre `Website Booking — Notify Assignee`.
3. Añade el trigger **Opportunity Stage Changed**.
4. Filtra por **Pipeline de Servicios → Cita Confirmada**.
5. Añade **Send Internal Notification**, primero como notificación de aplicación y luego como email.
6. Selecciona **Assigned User** como destinatario.

Usa el selector de merge fields de HighLevel para insertar los campos, sin copiar IDs internos:

```text
Nueva cita web confirmada

Cliente: [Contact Full Name]
Teléfono: [Contact Phone]
Email: [Contact Email]

Dirección: [Website Quote - Service Address]
Vehículo: [Website Quote - Vehicle Year] [Website Quote - Vehicle Make] [Website Quote - Vehicle Model]
Color: [Website Quote - Vehicle Color]
Placa: [Website Quote - License Plate]

Categoría: [Website Quote - Category]
Paquete: [Website Quote - Package]
Tamaño o cantidad: [Website Quote - Size or Quantity]
Extras: [Website Quote - Add-ons]
Servicios: [Website Quote - Item Count]
Desglose: [Website Quote - Items]
Estimado web: [Website Quote - Estimate]
Depósito: [Website Quote - Deposit Due]
Duración: [Website Quote - Service Duration]

Fecha: [Website Quote - Preferred Date]
Horario: [Website Quote - Preferred Time]
Modo: [Website Quote - Booking Mode]
Estado: [Website Quote - Booking Status]
Appointment ID: [Website Quote - Appointment ID]
Notas: [Website Quote - Customer Notes]

Idioma: [Website Quote - Language]
Aceptación de políticas: [Website Quote - Policy Accepted At]
Submission ID: [Website Quote - Submission ID]
```

Publica el workflow y prueba una reserva normal y otra de día completo. La primera debe retirar un turno; la segunda debe cerrar los tres turnos de la fecha.

## Seguridad y rotación

Mantén el token solamente en Vercel Production. No lo añadas al navegador, Git, Preview ni documentación. Después de una prueba con credenciales temporales, rota el token, actualiza `GHL_PRIVATE_TOKEN`, despliega producción y expira el anterior.
