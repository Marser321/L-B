# Workflow de notificaciones para cotizaciones web

El formulario crea cada solicitud en **Pipeline de Servicios → Pendiente de Información**. Los campos de oportunidad ya fueron creados mediante la API. La creación y publicación del workflow se hace manualmente porque HighLevel no ofrece esa operación mediante Private Integration Token.

## Crear el workflow

1. Abre **Automation → Workflows → Create Workflow → Start from scratch**.
2. Usa el nombre `Website Quote — Notify Admins`.
3. Añade el trigger **Opportunity Created**.
4. Filtra por **In Pipeline → Pipeline de Servicios** y guarda el trigger.

## Notificación por email

Añade **Send Internal Notification** con estos valores:

- Type: **Email**.
- To User Type: **All Admins**.
- Subject: `Nueva cotización web — [Contact Full Name]`.
- Message: usa el selector de valores de HighLevel para insertar los campos; no escribas manualmente los identificadores internos.

```text
Nueva cotización web

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
Estimado web: [Website Quote - Estimate]

Fecha preferida: [Website Quote - Preferred Date]
Horario preferido: [Website Quote - Preferred Time]
Notas: [Website Quote - Customer Notes]

Idioma: [Website Quote - Language]
Aceptación de políticas: [Website Quote - Policy Accepted At]
Submission ID: [Website Quote - Submission ID]
```

## Notificación dentro de HighLevel

Añade otra acción **Send Internal Notification**:

- Type: **Notification**.
- To User Type: **All Admins**.
- Title: `Nueva cotización web — [Contact Full Name]`.
- Message: `[Website Quote - Package] · [Website Quote - Estimate] · [Website Quote - Preferred Date] [Website Quote - Preferred Time]`.
- Redirect Page: selecciona la oportunidad o la página de oportunidades.

Guarda las acciones y pulsa **Publish**. Después envía una cotización real desde el sitio y comprueba que todos los administradores reciben un email y una alerta dentro de HighLevel.

## Rotar el token

Cuando la prueba de notificaciones termine:

1. Abre **Settings → Private Integrations** y rota el token utilizado por el sitio.
2. Sustituye `GHL_PRIVATE_TOKEN` en **Vercel → l-b → Settings → Environment Variables → Production**.
3. Crea un nuevo deployment de producción.
4. Expira inmediatamente el token anterior.

No añadas el token a Git, al navegador, a Preview ni a este documento.
