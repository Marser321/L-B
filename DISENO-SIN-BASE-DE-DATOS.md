# Diseño: la agenda y las membresías sin base de datos

Al 4 de agosto de 2026. Las cinco decisiones de negocio están tomadas (§4); la
implementación no empezó.

Docs relacionados: `AGENDA.md` (cómo funciona hoy, con Postgres), `MEMBERSHIPS.md`
(cobro recurrente), `PANORAMA.md` (qué se vende y por dónde se cobra).

---

## 0. Por qué esto es posible ahora

Dos cosas cambiaron:

1. **Una visita es una camioneta en una dirección**, atendiendo los vehículos en
   secuencia. Reservar dejó de ser "asignar N camionetas simultáneas de forma atómica"
   y pasó a ser "una camioneta, una ventana contigua" — que es exactamente lo que es una
   cita de calendario.
2. **HighLevel valida y serializa** las citas. Probado el 4 de agosto contra la
   subcuenta real: una cita de 3h30 entra en un calendario configurado a 30 min, una
   cita solapada recibe 400 `"The slot you have selected is no longer available."`, y de
   4 pedidos concurrentes idénticos gana **exactamente uno** (tres corridas, ganador
   distinto cada vez).

El segundo punto es el que reemplaza la restricción de exclusión de Postgres.

---

## 1. La agenda

### El estado vive en cuatro objetos que ya existen en el CRM

| Qué | Dónde | Reemplaza a |
|---|---|---|
| La reserva (cuándo, qué camioneta, cuánto dura) | Una **cita** en el calendario de la camioneta | `bookings`, `booking_assignments`, `booking_holds`, `hold_allocations` |
| El cliente | El **contacto** | — (ya estaba) |
| La venta | La **oportunidad** | — (ya estaba) |
| El pago | La **factura** | `payment_events` |

### El hold y la reserva son el MISMO objeto, con distinto estado

`appointmentStatus` hace de máquina de estados y no hace falta nada más:

```
new        → reservado, esperando pago   (lo que hoy es un hold de 15 min)
confirmed  → pagado
cancelled  → liberado
showed     → servicio entregado
```

Esto resuelve de paso **el segundo bug encontrado el 4 de agosto**: el hold de hoy usa
`POST /calendars/events/block-slots`, que devuelve 400 `"The calendar is not an event
calendar."` en los calendarios de camioneta (son tipo *Personal*). Las citas sí
funcionan. El hold pasa a ser una cita en estado `new`.

### El contacto ya está disponible en el momento del hold

Una cita exige `contactId`, así que la primera lectura de esto fue "hay que reordenar el
wizard". **No hace falta.** Los campos del cliente viven en el **paso 4**, junto al
calendario, y el hold se toma al **salir** del paso 4 (`script.js`, `acquireTemporaryHold`).
`contactValid()` ya exige nombre, teléfono, email, calle, ciudad y código postal antes de
habilitar el botón.

Los datos están completos y validados cuando se pide el hold; el frontend simplemente no
los estaba enviando. El hold pasa a crear el contacto (`/contacts/upsert`, que ya se usa
en `quote.js`) y con ese `contactId` crea la cita. Nada de contactos placeholder que
después hay que reasignar.

### Expiración perezosa, sin cron frecuente

El plan Hobby de Vercel solo permite **un cron diario**, así que un hold de 15 minutos
no puede depender de un barrido. En su lugar:

- Al calcular disponibilidad, una cita `new` con más de 15 minutos se considera **libre**.
- Al crear el hold, si HighLevel responde 400, se mira quién bloquea: si es una cita
  `new` vencida, se borra y se reintenta una sola vez.

Autoreparable, sin estado propio, y el cron diario queda como red de seguridad.

### Idempotencia sin tabla

- **Hold:** antes de crear, se leen las citas del día en las camionetas y se busca el
  `submissionId` en el título. Una lectura, barata.
- **Pago:** en vez de aplicar eventos, se **consulta el estado de la factura**.
  Consultar estado es idempotente por naturaleza — el problema se disuelve en lugar de
  resolverse con una tabla de eventos.

### Lo que se pierde, honestamente

La garantía **formal** de atomicidad. Lo de HighLevel es una validación del servidor,
no una restricción transaccional documentada. Empíricamente serializa (3 de 3), pero es
un comportamiento observado, no un contrato. Las dos sondas quedaron en
`scripts/probe-ghl-slot-*.mjs` para detectar en 10 segundos si algún día cambia.

---

## 2. Las membresías

### El contrato es una oportunidad

Una oportunidad por **vehículo** contratado, en un pipeline propio (`Membresías`), con
estos campos personalizados:

| Campo | Ejemplo | Para qué |
|---|---|---|
| `Membresía - Tipo` | `2x` / `4x` | cuántos lavados incluye el ciclo |
| `Membresía - Vehículo` | `Toyota Camry 2024 · ABC-123` | a qué vehículo aplica |
| `Membresía - Ciclo vence` | `2026-09-04` | hasta cuándo valen los créditos |
| `Membresía - Estado` | `activa` / `vencida` / `cancelada` | si puede reservar |

**No hay campo de "créditos usados".** Ver el punto siguiente.

### Los créditos se DERIVAN, no se almacenan

Un contador en un campo personalizado se puede corromper: dos procesos leen 1 y
escriben 2. Y un número guardado no explica de dónde salió.

En su lugar:

```
lavados usados este ciclo = cantidad de citas de esta membresía
                            con estado `showed`
                            y fecha >= inicio del ciclo
```

El inicio del ciclo sale de la última factura pagada. La cita se marca como de
membresía poniendo el id de la oportunidad en el título o en un campo.

Ventajas: **no hay contador que se desincronice**, el número siempre se puede auditar
mirando el calendario, y "¿por qué me quedan 1?" tiene una respuesta que se ve.

Regla que hace el trabajo pesado: **una sola visita futura por contrato**. Si el
miembro no puede tener dos lavados agendados a la vez, no hay carrera posible —
para agendar el segundo, el primero ya tiene que estar entregado.

### Las 48 horas

No cambia nada: ya es un cálculo puro sobre la hora pedida contra el momento actual,
en `catalog.js` (`MEMBERSHIP_BOOKING_NOTICE_MS`). El endpoint de disponibilidad
simplemente **no ofrece** turnos dentro de las 48 h cuando el carrito es de membresía.
No requiere base de datos ni la requería.

Nota: **no** conviene configurar las 48 h en el calendario de HighLevel, porque
aplicaría también a los clientes que no son miembros.

### El flujo del miembro: un link, no una cuenta — **IMPLEMENTADO 4 ago 2026**

`mi-membresia.html` (estático) + `api/member.js` + `api/_lib/membership-crm.js`.
El link se emite con `node scripts/member-link.mjs <opportunityId>`.

**Sin una sola consulta a Postgres.** Es el primer flujo escrito enteramente como va a
ser todo: el contrato es la oportunidad, el saldo se cuenta del calendario, y reservar es
probar camionetas en orden dejando que HighLevel arbitre.

Lo que quedó acotado y cubierto por tests: un link abre **un** contrato; no expone
teléfono, email, dirección ni datos de otro miembro; solo puede reservar algo a lo que el
contrato ya da derecho, con 48 h de aviso y dentro del ciclo pagado; y no puede cancelar,
reprogramar, cambiar de plan ni mover plata.



Usuarios y contraseñas son un subsistema entero (registro, recupero, sesiones). Para
esto alcanza un **link personal firmado**:

```
lybelitewash.com/mi-membresia?t=<firma HMAC del contacto + contrato>
```

Sin estado: la firma se valida con un secreto del servidor. Se invalidan todos
rotando el secreto. El link se manda por SMS/email cuando se activa la membresía, y
queda en el CRM para que la oficina lo reenvíe.

Lo que ve el miembro al abrirlo:

```
Camry · Membresía 2x
Te quedan 1 lavado hasta el 4 de septiembre
Próximo lavado: viernes 8 de agosto, 9:00

[ Agendar mi lavado ]
```

Y ese botón **saltea todo el cotizador**: categoría, paquete, tamaño y add-ons ya están
en el contrato. Va directo al calendario, ya filtrado a ≥48 h. Un toque en un horario y
listo — sin paso de pago, porque el ciclo ya está pago.

### Y si entra por el cotizador normal

En el paso de resumen, si el teléfono o el email coinciden con un contrato activo para
ese vehículo, aparece:

> **Tenés 1 lavado de membresía disponible para el Camry.**
> [ Usar mi lavado de membresía ] — el total pasa a $0

Si lo canjea, la reserva se marca como visita de membresía y no se cobra ni depósito ni
servicio. Detectarlo son 2 llamadas al CRM en el paso de resumen: contacto por
teléfono/email, y sus oportunidades.

### Reglas de CONCESIÓN que hay que reimplementar

Sacar Stripe borró el transporte, y con él las reglas que solo ocurren cuando entra un
pago. Quedan escritas acá porque ya no están en código ni en tests, y la implementación
con HighLevel las tiene que satisfacer:

| Regla | Qué debe pasar |
|---|---|
| **Un contrato, una suscripción** | La oportunidad guarda su `Membership Subscription ID` (el campo que dejó Stripe, reutilizado). Antes de pedirle una factura recurrente a HighLevel se escribe un marcador `pending:`; si un reintento lo encuentra, **busca el schedule huérfano y lo adopta, y si no lo encuentra se niega a crear otro** (409 `MEMBERSHIP_SCHEDULE_IN_DOUBT`). Fallar cerrado: una membresía que la oficina termina a mano cuesta muchísimo menos que un doble cobro mensual |
| Activación | La primera factura pagada pone el contrato en `activa`, fija el ciclo y concede la cantidad del plan |
| **Renovación sin acumular** | Un ciclo pagado **reinicia** el balance a la cantidad del plan; no suma. 2 + 2 nunca es 4 |
| Impago | La factura fallida pasa el contrato a `vencida`: bloquea reservas nuevas y **no toca** la visita ya agendada del ciclo pagado |
| Baja al fin del ciclo | Conserva el ciclo en curso y detiene la renovación |
| Cancelado | Bloquea reservas futuras y conserva el historial |

Lo que **sí** sigue en código y probado es el lado del gasto: 48 h de aviso, crédito
consumido al completar, cancelación tardía y no-show que lo gastan igual, una sola visita
abierta por contrato, y balance agotado que rechaza la siguiente reserva.

### Automatizaciones en el CRM

| Disparador | Qué hace |
|---|---|
| Factura pagada | `Ciclo vence` = +1 mes, `Estado` = activa, y manda el link personal |
| Factura falla | `Estado` = vencida (bloquea nuevas reservas, no toca la ya agendada) |
| 3 días antes de vencer el ciclo con lavados sin usar | Recordatorio: "te queda 1 lavado" |

Ese último es retención pura, y solo es posible porque los créditos son visibles.

---

## 3. Qué tablas se van y qué queda

| Tabla | Destino |
|---|---|
| `booking_holds`, `hold_allocations`, `bookings`, `booking_assignments` | **se van** — son la cita |
| `resource_rotation` | **se va** — la rotación se deriva de la fecha (`día % 4`) |
| `payment_events`, `stripe_events` | **se van** — se consulta el estado de la factura |
| `notification_deliveries` | **se va** — los workflows del CRM se disparan por estado |
| `highlevel_sync_state` | **se va** — no hay nada que sincronizar |
| `membership_*`, `crm_price_map` | **se van** si las membresías se cobran con facturas recurrentes de HighLevel en vez de Stripe |
| `schema_migrations` | queda huérfana; se borra la base entera al final |

**No hay migración 004 y no va a haberla.** Se escribió para eliminar
`booking_assignments_resource_unique`, la restricción que exigía camionetas distintas
por vehículo. Pero esa restricción se dispara solo si una visita escribe **una fila por
vehículo**, y eso era una mala descripción de la realidad: una camioneta en una
dirección está ocupada **un bloque contiguo**, no N bloques.

Así que la visita escribe **una sola fila de asignación**, que abarca toda la cadena. La
restricción queda satisfecha por construcción, sin tocar el esquema, y el repositorio en
memoria la sigue enforzando — un fake más permisivo que producción es exactamente cómo
una reserva pasa 174 tests y después falla con un cliente.

El detalle por vehículo no necesita filas: se deriva del inicio de la visita más el
`offsetMinutes` de cada vehículo, que se guarda en el quote. Y en HighLevel es **una
cita** por visita, con el orden de trabajo en la descripción, en lugar de N citas para
la misma casa.

---

## 4. Decisiones del dueño — 4 de agosto de 2026

| # | Decisión |
|---|---|
| 1 | Hoy **no** se ajustan créditos a mano, pero no se descarta. Y hace falta un **panel para la cuadrilla** (ver §5) |
| 2 | El miembro **sí puede sumar add-ons** pagando la diferencia (ver §6) |
| 3 | **Link firmado**, no cuentas con contraseña — mantenerlo simple |
| 4 | El crédito se consume **al completar** el servicio |
| 5 | **Todo en HighLevel.** Se elimina Stripe: un solo lugar donde queda registrado |

La decisión 5 borra `api/webhooks/stripe.js`, `api/memberships/checkout.js`,
`api/memberships/visits.js` y los dos endpoints internos de membresías — cinco rutas.
Eso importa por una razón práctica: el plan Hobby de Vercel permite **12 funciones
serverless** y hoy estamos en 12 exactas. Sacar Stripe libera el lugar para el panel de
la cuadrilla y el del miembro sin pagar Pro.

```
hoy:  14 rutas (2 excluidas del deploy) = 12 desplegadas
luego: 14 − 5 (Stripe) + 2 (cuadrilla, miembro) = 11
```

---

## 5. Panel de la cuadrilla — **IMPLEMENTADO 4 ago 2026**

`cuadrilla.html` (estático, no gasta función) + `api/crew.js` + `api/_lib/crew-link.js`.
Los links se emiten con `node scripts/crew-links.mjs`, que es un script y no un endpoint
a propósito: imprimir un link acuña una capacidad que puede marcar plata cobrada, así que
vive en una terminal con el secreto a mano, no en la web.

Lo que quedó acotado, y está cubierto por tests:

| Límite | Cómo |
|---|---|
| Solo HOY | La ventana se calcula en la zona del negocio, no en la del teléfono |
| Solo SU camioneta | El token nombra la camioneta y el calendario se resuelve del config; el request no puede nombrar un calendario |
| Solo cinco acciones | `attended`, `no_show`, `cancel`, `cash`, `payment_link`. Cualquier otra string es 422 |
| Nada destructivo | Cancelar mueve el **estado** de la cita, no la borra. No hay `DELETE` ni reprogramar |
| Sin datos del cliente | Ni teléfono, ni email, ni identificadores de CRM. Solo nombre y dirección |
| Monto acotado | Entre 1 y 5000, para que un dígito de más no registre miles — vale para efectivo y para link |

La cita se verifica listando el día y buscando el id, **no** confiando en el id — si no,
el token permitiría editar cualquier cita de la cuenta.



Es la pieza que **cierra el circuito de los créditos derivados**: alguien tiene que
marcar la cita como `showed`, y esa persona es quien hizo el lavado.

Mismo patrón que el link del miembro: **link firmado por camioneta**, sin login.

```
lybelitewash.com/cuadrilla?t=<firma HMAC de la camioneta>
```

La pantalla lista **solo el día de hoy y solo esa camioneta**, leído de su calendario:

```
9:00 · 1234 Palm Ave · Jane Driver
  Camry — Basic Wash          $55
  Civic — Basic Wash          $55
  Total $110 · depósito $30 pagado · resta $80

  [ Atendida ]        [ No estaba ]
  [ Cobré efectivo ]  [ Link de pago ]
  [ Cancelar la cita ]
```

| Botón | Qué hace en HighLevel |
|---|---|
| `Atendida` | `PUT` sobre la cita → `appointmentStatus: showed`. En una visita de membresía, **esto es lo que consume el crédito** |
| `No estaba` | `appointmentStatus: noshow`. **También consume el crédito**: la camioneta viajó y el turno se perdió |
| `Cancelar la cita` | `appointmentStatus: cancelled`. Gratis: devuelve el crédito y libera la "única visita abierta" del contrato |
| `Cobré efectivo` | `POST /invoices/` + `/invoices/{id}/record-payment` con `mode: "cash"` |
| `Link de pago` | `POST /invoices/text2pay` con `action: send`. **No marca nada pagado**: la plata todavía no está |

El panel arrancó con dos botones y creció a cinco por una sola razón: **cada desenlace que
no puede registrar es un desenlace por el que la oficina tiene que abrir HighLevel.** Una
cuadrilla que puede marcar un lavado entregado pero no un cliente que nunca abrió el
portón movió el trabajo, no lo eliminó.

Lo que sigue afuera a propósito: **borrar** (perdería el historial que la fórmula de
créditos lee) y **reprogramar** (mover una visita es una conversación con el cliente, no
un botón en una entrada de garaje).

Reglas de alcance, porque un link que marca cobros es una capacidad real:

- Firmado con un secreto del servidor; se invalidan todos rotando el secreto.
- Solo puede actuar sobre citas **de su camioneta** y **de hoy**. Nada histórico, nada
  de otra camioneta.
- Cada acción deja nota en el contacto (quién y cuándo), así el cobro en efectivo es
  auditable.
- No expone teléfono ni email del cliente más allá de lo necesario para el servicio.

Y responde la decisión 1: el ajuste manual de créditos sale gratis como efecto
secundario. Un lavado de cortesía es una cita marcada como cortesía que **no** cuenta en
la fórmula de créditos.

---

## 6. Add-ons sobre un lavado de membresía

El lavado base está pago por el ciclo; los add-ons no. El flujo del miembro gana un
paso **opcional**:

```
[ Agendar mi lavado ]
      ↓
  elegir horario (≥48 h)
      ↓
  ¿Querés agregar algo?           ← opcional, se puede saltear
  □ Limpieza de motor      $30
  □ Tratamiento con ozono  $40
      ↓
  sin add-ons  → reservado, no se cobra nada
  con add-ons  → reservado + factura por SOLO la diferencia
```

Dos formas de pagar la diferencia, y las dos ya existen:

1. **Ahora**, con el link de pago de la factura.
2. **Al técnico**, en efectivo — y lo registra la cuadrilla desde su panel con el botón
   `Cobré efectivo`. Si el cliente prefiere tarjeta, `Link de pago` le manda la factura
   por SMS y email y la abre en el teléfono de la cuadrilla para que pague ahí mismo.

Importante para que la cuadrilla no cobre dos veces: cuando los add-ons se facturan
**online**, la cita se escribe con `total: $0`. El saldo que ve el panel sale de ese
campo, así que un add-on ya facturado **no** aparece como algo a cobrar en la puerta. El
importe queda igual en el registro, bajo `extras_monto`. Y si la factura online no llega
a salir, el servidor **reescribe la cita a cobro en efectivo** — la visita nunca se cae,
porque el lavado base ya está pago por el ciclo.

La segunda opción es la que hace que el panel de la cuadrilla y los add-ons de membresía
se apoyen mutuamente en lugar de ser dos features separadas.

Nada nuevo en precios: los add-ons ya están en el catálogo y `pricing.js` ya calcula el
total. Lo único nuevo es facturar **solo los add-ons** en vez del servicio completo.

Importante: la visita queda **confirmada igual** aunque la diferencia no esté pagada.
El lavado base está cubierto por el ciclo, así que un add-on sin pagar no puede
bloquear un servicio al que el miembro tiene derecho.
