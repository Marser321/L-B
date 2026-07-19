# HighLevel: calendario, pipeline y notificaciones web

El sitio mantiene su configurador propio. El servidor crea o actualiza el contacto, registra una oportunidad por `Submission ID`, consulta la disponibilidad real y crea una cita confirmada en **Website Bookings — Mobile Team**.

Los datos personales usan los campos estándar del contacto. Servicio, vehículo, extras, dirección operativa, estimado y datos de la cita se guardan en campos de oportunidad para conservar cada reserva por separado.

Una reserva puede incluir **varios vehículos/servicios en una sola visita** (carrito). Todos comparten fecha, franja y dirección, y generan **una sola cita y una sola oportunidad**. El desglose por vehículo queda en `Website Quote - Items` (una línea numerada por servicio) y el total de líneas en `Website Quote - Item Count`; los campos de vehículo muestran los valores de todas las líneas separados por `; `.

> ⚠️ Tras actualizar el backend con soporte de carrito hay que **volver a ejecutar `node scripts/setup-ghl.mjs`** antes del deploy, para crear los campos nuevos `Website Quote - Items` y `Website Quote - Item Count`. Si faltan, el endpoint responde 503 (`custom fields are not configured`).

## Permisos del Private Integration Token

El token de subcuenta necesita, como mínimo:

- `contacts.readonly` y `contacts.write`
- `opportunities.readonly` y `opportunities.write`
- `locations/customFields.readonly` y `locations/customFields.write`
- `calendars.readonly`
- `calendars/events.readonly` y `calendars/events.write`
- `calendars.write` solamente cuando el script de setup deba crear el calendario

## Preparación de la subcuenta

1. En **Opportunities → Pipelines**, confirma que `Pipeline de Servicios` tenga las etapas `Pendiente de Información` y `Cita Confirmada`.
2. Define `GHL_PRIVATE_TOKEN`, `GHL_LOCATION_ID` y `GHL_ASSIGNED_USER_ID` en una sesión local segura.
3. Ejecuta `node scripts/setup-ghl.mjs`.
4. El script crea los campos faltantes, localiza o crea `Website Bookings — Mobile Team` y muestra los IDs que deben guardarse en Vercel.
5. Revisa el calendario: lunes a sábado, `America/New_York`, 8am–8pm, tres horas por cita, intervalo de cuatro horas, una hora de buffer, 24 horas de anticipación y 60 días de ventana.
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
