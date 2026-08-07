# Panorama: qué se vende, por dónde se cobra, qué falta

Mapa completo del sistema comercial de L&B Elite Wash & Detail, a **28 de julio de 2026**.
Docs relacionados: `AGENDA.md` (cómo una visita consigue camioneta) y `MEMBERSHIPS.md`
(cobro recurrente).

---

## 1. Qué se vende

| Tipo | Productos | Variantes de precio | Dónde vive el precio |
|---|---|---|---|
| Servicios únicos (lavados, detailing, pintura) | 23 | 61 | `catalog-prices.json` → `pricing.js` |
| Add-ons | 46 vendibles (+1 a cotizar) | 46 | `pricing.js` |
| Depósitos de reserva | 2 ($30 / $50) | 2 | `catalog.js` |
| Membresías mensuales | 17 | 33 | `membership-catalog.js` |
| **Total** | **88** | **142** | |

Los 33 precios de membresía coinciden exactamente con los del catálogo público, y hay
un test que falla si alguna vez divergen. Ningún importe viaja nunca en un request:
el navegador manda identificadores y el servidor resuelve el precio.

## 2. Por dónde se cobra

| Camino | Qué cobra | Cómo se dispara | Estado |
|---|---|---|---|
| Depósito de reserva | $30 / $50 | Automático al reservar en la web | En vivo |
| Link de pago manual | Cualquier servicio + add-ons + depósito | `POST /api/payments/links` con `OFFICE_API_TOKEN` | **Nuevo, sin usar en producción** |
| Link desde el picker del CRM | Cualquier producto del catálogo | La oficina, a mano en HighLevel | **Habilitado por el catálogo nuevo** |
| Membresías | Mensual recurrente | Facturas recurrentes de HighLevel | **Resuelto: Stripe eliminado el 4 ago; falta implementar el motor GHL** |

### Lo que cambió en esta tanda

Antes, **ningún servicio existía como producto en el CRM**: sólo las membresías y dos
productos de depósito heredados. El depósito de la web era un invoice con una línea de
texto libre llamada "Booking Deposit" — imposible de reportar por producto e imposible
de reutilizar en un link manual.

Ahora existe `scripts/provision-crm-catalog.mjs`, que crea los 88 productos y 142 precios
en HighLevel. Con eso, la oficina puede abrir el CRM, elegir "Premium Detail · SUV" y
mandar un link; y el link del depósito de la web pasa a estar compuesto por esos mismos
productos.

**El provisionador no puede tocar los productos de depósito heredados.** Sólo reconoce
objetos que llevan su marcador en la descripción; los viejos no lo tienen, así que le son
invisibles.

### Lo que hay hoy en la subcuenta (dry-run real, 28 jul 2026)

**21 productos**: los 17 de membresía (reconocidos por el provisionador nuevo — marcador
compatible, 0 a crear) y **4 ajenos**, que no son lo que este documento suponía:

| Producto | Precio | Tipo |
|---|---|---|
| `Cars (via calendars)` | `Cars @ 30` — $30 | DIGITAL |
| `Trucks (via calendars)` | `Trucks @ 50` — $50 | DIGITAL |
| `Marine (via calendars)` | `Marine @ 50` — $50 | DIGITAL |
| `Mobile Homes (via calendars)` | **`Copy of Trucks @ 50`** — $50 | DIGITAL |

No se llaman "Booking Deposit": los creó HighLevel desde la configuración de pagos de los
calendarios, tienen la **descripción vacía** y son de tipo DIGITAL. Los importes sí son los
$30 / $50 esperados.

Dos cosas para decidir:

1. **Si se provisionan los depósitos, quedan seis productos de depósito** (4 viejos + 2
   nuevos marcados). Se puede evitar corriendo `--kinds service,addon,membership` y
   seguir usando los de calendario.
2. El precio de Mobile Homes se llama **"Copy of Trucks @ 50"** — quedó de un copiar y
   pegar. Ese nombre es el que vería la oficina en el selector de un link de pago.

## 3. Qué dispara cada cosa

```
Cliente en la web
  ├─ /api/catalog ............. qué se ofrece (ids + textos, sin autoridad de precio)
  ├─ /api/availability ........ horarios con N camionetas libres
  ├─ /api/bookings/holds ...... retención de 15 minutos
  ├─ /api/quote ............... datos del cliente + link de depósito
  └─ /api/payments/webhook .... el pago verificado confirma la reserva

Oficina
  ├─ /api/payments/links ...... link de pago a medida            (OFFICE_API_TOKEN)
  ├─ /api/memberships/visits .. completar / cancelar / no-show   (OFFICE_API_TOKEN)
  ├─ POST /api/internal/dependencies .... catálogo en el CRM   (MEMBERSHIP_PROVISION_SECRET)
  ├─ /api/internal/dependencies ........... diagnóstico          (OFFICE_API_TOKEN)
  └─ HighLevel a mano ......... link desde el picker de productos

Automático
  └─ /api/bookings/expire ..... libera retenciones vencidas (cron)
```

## 4. Reglas que el sistema garantiza

Vale la pena tenerlas escritas porque varias no son obvias y están respaldadas por la
base de datos, no sólo por código:

- **Una camioneta por DIRECCIÓN, en secuencia.** La cuadrilla viaja una vez y atiende los
  vehículos del garaje uno tras otro, así que los servicios **se suman**: tres sedanes son
  3h30, no 1h30. El buffer de traslado se cobra una sola vez, al final.
- **La flota limita CLIENTES simultáneos, no vehículos por cliente.** Cuatro camionetas
  son cuatro direcciones a la misma hora.
- **Máximo 4 vehículos por reserva** (HTTP 422), o **2 si el carrito lleva náutica**, ya que
  cada bote o jet ski son dos horas de servicio.
- **Una camioneta no puede tener dos trabajos superpuestos**: constraint de exclusión en
  el calendario de HighLevel, no un `if`.
- **Sólo un webhook de pago verificado confirma una reserva.**
- **48 h de antelación sólo para membresías**; el resto conserva 1 h.
- **Los créditos de membresía no se acumulan** y se descuentan al completar el servicio,
  no al reservar.
- **Una sola visita futura por contrato**: índice único parcial.
- **Un mensaje por hecho**: `notification_deliveries` con clave única, así un reintento de
  Stripe o del CRM nunca manda dos SMS.

## 5. Casos de uso que siguen sin resolver

Esto es lo que hoy **no** tiene solución. Está ordenado por cuánto duele en el día a día.

| # | Caso | Estado | Impacto |
|---|---|---|---|
| 1 | **Reprogramar una reserva** | ✅ **Resuelto** — `action: reschedule`, sin consumir crédito | — |
| 2 | **Registrar un pago en efectivo / Zelle** | ✅ **Resuelto** — `POST /api/payments/manual` | — |
| 3 | **Reembolso o cancelación con depósito cobrado** | Sin política ni endpoint | Alto |
| 4 | **Recuperar un `past_due`** | El contrato se marca, pero no hay reintento ni link de recupero | Medio |
| 5 | **Cambiar de plan de membresía** | No existe | Medio |
| 6 | **Cambiar el vehículo de un contrato** | No existe | Medio |
| 7 | **Pausar una membresía** | No existe | Medio |
| 8 | **Venta mostrador sin reserva** | Parcial: ya se puede mandar un link manual, pero no queda registrada como venta con servicio prestado | Medio |
| 9 | **Gift cards / prepagos** | No existe | Bajo |
| 10 | **Reporte de ventas por producto** | Habilitado por el catálogo nuevo; falta correr el provisionador en producción | Bajo |

### Los dos que se resolvieron, y por qué importaban

**Reprogramar.** La única salida era cancelar y volver a reservar, y dentro de las 24 h
eso consumía el crédito: un cliente que corría su cita un día pagaba como si no hubiera
venido. Ahora se mueve sin costo, y el orden de las operaciones importa — **primero se
toma el horario nuevo y recién después se suelta el viejo**, así un intento fallido no
deja al cliente sin cita. Hay un test que lo comprueba con la flota llena.

**Pago en efectivo.** Se podía "resolver" armando a mano una llamada al webhook con el
secreto, lo cual no dejaba constancia de quién cobró ni cómo. Ahora pasa por el mismo
camino de pago verificado — con el mismo control de monto insuficiente y la misma
garantía de una sola vez — y registra método, referencia y quién lo tomó.

### El siguiente que más urge

**Reembolso / cancelación con depósito ya cobrado.** No hay política escrita ni endpoint:
hoy se resuelve conversando y devolviendo por fuera del sistema, sin registro.

## 6. Deuda técnica conocida

1. **Dos motores de membresía — pendiente y deliberadamente no forzado.** Conviven el
   propio de Stripe (`stripe.js`, `/api/webhooks/stripe`, `/api/memberships/checkout`) y
   el del CRM (`crm-recurring-memberships.js`, endpoints en `/api/internal/`). Está
   decidido que quede **sólo el del CRM**.

   No se hizo en esta tanda a propósito: los últimos diez commits del repositorio son
   correcciones sucesivas al contrato de invoices recurrentes de HighLevel — el schema
   del payload, el `executeAt`, la versión de la API, el formato de la respuesta. Ese
   contrato todavía se está descubriendo con el endpoint de prueba. Mover el checkout de
   producción a una API cuya forma aún se está averiguando es la peor secuencia posible
   para algo que cobra dinero. **Primero terminar de sondear con
   `/api/internal/membership-recurring-test`, después migrar.**
2. **Nada de esto se ejecutó nunca contra las cuentas reales.** Ni la API de productos del
   CRM, ni los links de pago, ni el cobro recurrente. Todo está cubierto contra dobles que
   imitan la API. El dry-run del provisionador es la primera verificación real.
3. **`createDepositPayment` quedó como código muerto** en `api/quote.js`, marcado con
   `TODO(remove-legacy-deposit)`, hasta confirmar el camino nuevo en producción.
4. **El cron de expiración corre una vez por día** (`vercel.json`), no cada 5 minutos. Una
   retención abandonada bloquea camionetas más de lo necesario.

## 7. Puesta en marcha de lo nuevo

```bash
npm install
node scripts/provision-crm-catalog.mjs               # dry run: 88 productos / 142 precios
node scripts/provision-crm-catalog.mjs --apply       # escribe en el CRM y en el price map
```

Variables nuevas o recién documentadas: `MEMBERSHIP_PROVISION_SECRET`, `DATABASE_SSL_MODE`,
`GHL_VAN_USER_IDS`. Todas en `.env.example`.

Después del `--apply`, archivar a mano los dos productos de depósito viejos en HighLevel.

## 7 bis. Auditoría del 5 de agosto de 2026

Revisión independiente de la tanda de alta de membresías, add-ons y canje. Se arreglaron
tres cosas y se cerró el panel de la cuadrilla:

| # | Qué estaba mal | Estado |
|---|---|---|
| 1 | `enrollMembership` creaba una **segunda factura recurrente** en cada reintento: la oportunidad era idempotente pero el schedule no, y `requestId` en `ghlRequest` es solo para logging | ✅ Arreglado — `Membership Subscription ID` + marcador `pending:`, falla cerrado |
| 2 | La cuadrilla veía **"resta $40" en add-ons ya pagados online** y los cobraba de nuevo en efectivo | ✅ Arreglado — `total: $0` cuando se facturan online; el importe queda en `extras_monto` |
| 3 | El canje reventaba con 422 opaco si la agenda corría en modo `full_day` | ✅ Arreglado — el servidor resuelve el primer horario libre y lo devuelve en `startsAt` |
| 4 | `moneyFromDescription` matcheaba `total:` sin límite de campo, así que cualquier clave terminada en esa palabra se leía como el saldo a cobrar | ✅ Arreglado — anclado al separador de campos |
| 5 | El panel de la cuadrilla no sabía registrar un no-show, una cancelación ni un cobro con tarjeta | ✅ Arreglado — cinco acciones; `noshow` ahora gasta el crédito, `cancelled` lo devuelve |
| 6 | El test del token de canje alteraba **el último carácter base64url**, que puede llevar bits de relleno: varios caracteres decodifican a los mismos bytes, así que el token quedaba intacto y el test fallaba ~1 de cada 4 corridas | ✅ Arreglado — ahora corrompe bytes concretos (IV, tag y texto cifrado); 5 corridas seguidas en verde |

### Sondeo del CRM real — 5 de agosto de 2026

Hecho contra la subcuenta (`L & B Elite Wash & Detail`), solo lectura. Lo que se confirmó:

| Pregunta | Resultado |
|---|---|
| ¿El alta web ya cobró a alguien? | **No.** Hay 4 facturas recurrentes, las 4 en **Draft**, con `Last Issued On: -`, todas contra el contacto `L&B CRM Billing Test`. Son restos del endpoint de sondeo borrado (`crm-recurring-test-…`) |
| ¿Existe el pipeline `Memberships`? | **Sí**, con las 5 etapas exactas: Pending Payment → Active → Past Due → Cancel at Period End → Canceled. **0 oportunidades** en todas |
| ¿Están los campos personalizados? | **Sí**, los 6 de membresía. Y además existe `Membership Subscription ID`, huérfano de Stripe |
| ¿HighLevel altera el `name` del schedule? | **No.** El código viejo mandaba `L&B Membership <ref>` sin raya y el CRM lo muestra sin raya. El nombre se guarda literal, así que buscar por nombre exacto es fiable |

Dos correcciones que salieron de ahí:

1. **Los GET de `/invoices/schedule` iban con la versión equivocada.** El endpoint de
   sondeo borrado en `b2a7e21` llevaba escrito en su fuente que *"la API de creación
   está fijada a 2023-02-21, pero el endpoint de lectura se sirve bajo v3"* — y usaba v3.
   Era el único código de todo esto que llegó a correr contra la cuenta real. Las tres
   lecturas ahora usan `INVOICE_READ_VERSION = 'v3'`; solo el POST de creación conserva
   la versión fechada. Sin esto, `findScheduleByReference` nunca habría adoptado un
   schedule huérfano y todo reintento habría terminado en 409.
2. **Se reutiliza `Membership Subscription ID` en vez de crear un campo nuevo.** Ya
   existe, significa exactamente eso, y el pipeline no tiene ni una oportunidad con un
   valor viejo. **Eso elimina el paso de aprovisionamiento previo al deploy.**

### Sondeo de ESCRITURA en modo test — 5 de agosto de 2026

`scripts/probe-ghl-write.mjs`, con `liveMode:false` contra el contacto `L&B CRM Billing
Test`. El alta **no funcionaba**: tenía **cuatro** errores de contrato encadenados, y cada
uno solo aparecía al ejecutar el anterior. Ninguno lo habría atrapado un test con dobles.

| # | Qué estaba mal | Cómo se supo |
|---|---|---|
| 1 | `resolveItem` ponía `name: entry.label`, y **una entry de membresía no tiene `label`** (tiene `productLabel` y `priceLabel`). `JSON.stringify` descarta las claves `undefined`, así que la línea viajaba **sin nombre** | 422 literal: `items.0.name should not be empty` |
| 2 | El `_id` del schedule viene en la **raíz** de la respuesta. El código hacía `draft.schedule ?? draft`, y esta API **sí** tiene una clave `schedule` — pero contiene el rrule, no el objeto. Resultado: `MEMBERSHIP_SCHEDULE_FAILED` **mientras el schedule sí se había creado**, dejando una suscripción huérfana por intento | La respuesta real: `{_id, status, liveMode, …, schedule, items}` |
| 3 | La activación se llamaba con `body: {}` | 422 nombrando `altId, altType, liveMode` |
| 4 | Las lecturas iban con `?locationId=`; los endpoints de facturas se scopean por `altId`/`altType` | 422 en el GET |

Los cuatro están arreglados y fijados en tests (`tests/membership-enrollment.test.js`).
Tras el arreglo del nombre, **la creación pasa sin tocar fechas** — el `startDate` de hoy
y el `dayOfMonth` calculado eran correctos; se descartó por bisección contra el payload
del probe viejo.

La factura creada se inspeccionó en el CRM y sale bien: línea *"Membresía 2x — Cars &
SUVs · Sedan"*, $150, mensual el día 5, sin fin, título `MEMBERSHIP INVOICE`, prefijo
`MEM-` y botón *Pay $150.00*.

**`PUT /opportunities/{id}` FUSIONA los campos personalizados** — verificado escribiendo
solo `Membership Status` sobre una oportunidad con `Membership Plan` y `Membership
Checkout ID` cargados: los tres quedaron. La suposición de todo el código es correcta y
deja de ser deuda.

Faltaba un quinto error, que apareció al arreglar los cuatro:

| # | Qué estaba mal | Cómo se supo |
|---|---|---|
| 5 | La activación se llamaba sin `autoPayment` | Con `body: {}` → 422 `altId, altType, liveMode`; con esos tres → **500 `Cannot read properties of undefined (reading 'enable')`**; con `autoPayment: { enable: false }` → 200 |

**Resultado final, ejecutando `createAndSchedule()` — el código que se despliega:**

```
scheduleId: 6a734c150f55fb1c331f2784
importe mensual: $150 · liveMode: false
estado: draft → scheduled → active
⇒ ✅ EL ALTA DE MEMBRESÍA FUNCIONA. La suscripción queda activa.
```

`findScheduleByReference` reencuentra el schedule recién creado, así que el camino de
recuperación que evita el doble cobro también quedó probado de punta a punta.

**No hay link de pago en la respuesta, y está bien.** La respuesta de activación trae
`sentTo`: HighLevel **manda** la factura por email/SMS. O sea que "revisá tu email" es el
camino real, no un fallback degradado — conviene que el copy del frontend lo diga así.

### El cobro recurrente automático

`autoPayment.enable` en el alta va en `false`, y **no es una elección**: el único valor
que acepta `autoPayment.type` es `saved_card`, y eso exige un `customerId` y un
`paymentMethodId` **de Stripe** que no existen hasta que el miembro pagó una vez. Probado:
cualquier otro `type` es enum inválido, y `saved_card` sin esos ids es 422. Con ids
inventados el error viene **de Stripe** (`No such PaymentMethod`), que es la prueba de que
el mecanismo es real y solo le faltan datos.

De ahí el diseño:

```
alta          → schedule activo, autoPayment OFF → HighLevel manda la 1ª factura por email
1er pago      → el miembro entra la tarjeta; Stripe crea customer + payment method
webhook       → POST /invoices/schedule/{id}/auto-payment  → autoPayment ON
2º ciclo en adelante → se cobra solo
```

El paso del webhook está implementado en `api/payments/webhook.js` y es **best effort a
propósito**: si no consigue los ids, HighLevel sigue mandando la factura cada ciclo y la
plata igual entra. Nada del ciclo que el miembro ya pagó depende de que eso funcione.

El endpoint `POST /invoices/schedule/{id}/auto-payment` está verificado sobre un schedule
**activo** (sobre un borrador responde 400). De dónde salen exactamente los ids del pago
es lo único que queda sin confirmar, porque la subcuenta **nunca tomó un pago**: hay 0
transacciones. El código los busca en la factura y en `/payments/transactions`.

### Dos cosas más que salieron del sondeo

- **Cancelar una suscripción SÍ se puede por API**: `POST /invoices/schedule/{id}/cancel`
  responde 201. Eso abre los casos 5 y 7 de §5 (cambiar de plan, pausar), que figuraban
  como "no existe".
- **Un schedule activado no se puede borrar** — 400 `Invoice schedule is already
  associated with invoice`. El estado alcanzable es `cancelled`, que es el que importa.
  Solo un `draft` se borra del todo. El `DELETE` quiere `altId`/`altType` en la **query**.

## 9. Pasar los pagos de test a LIVE

Dos interruptores, separados a propósito para que encender las membresías no pueda tocar
los depósitos de $30/$50 que ya vienen funcionando:

| Variable | Qué pone en modo real |
|---|---|
| `GHL_DEPOSIT_LIVE_MODE=true` | los depósitos de reserva |
| `GHL_MEMBERSHIP_LIVE_MODE=true` | las suscripciones de membresía |

**Antes de tocarlos, correr el preflight**, que comprueba que la estructura del CRM esté
completa, que los 33 precios se resuelvan y que no haya ningún schedule en `liveMode`
suelto:

```bash
node --env-file=.env.probe scripts/payments-go-live.mjs
```

Con todo en verde imprime los comandos exactos de Vercel.

**Stripe ya no es un pendiente:** la subcuenta tiene los **dos modos habilitados, live y
test**, y es el proveedor Default (Payments → Integrations → Stripe → Manage, verificado el
5 ago 2026). Por eso estos dos flags son lo **único** que decide si la plata es real — cada
factura se emite contra uno u otro modo según su `liveMode`.

Lo que no cambia al pasar a live: **el primer ciclo siempre es una factura manual**; el
cobro automático se enciende recién con la primera tarjeta guardada.

Estado al 5 de agosto de 2026: **5 comprobaciones, 0 fallan**.

### En qué modo está producción

No se puede leer localmente: los flags están marcados *Sensitive* en Vercel, así que
`vercel env pull` los devuelve vacíos y cualquier script local sólo puede reportar su
propio entorno. Hay que preguntárselo al sitio desplegado:

```bash
curl -s -H "Authorization: Bearer $OFFICE_API_TOKEN" \
  https://l-b-lyart.vercel.app/api/internal/dependencies | jq .dependencies.payments
```

Devuelve `depositsEnabled`, `depositLiveMode` y `membershipLiveMode` tal como los ve
producción.

Lo que **queda abierto**:

- **En el CRM quedaron 3 schedules de sondeo en estado `cancelled`** (modo test, contacto
  de prueba, no cobran a nadie) con sus 3 facturas en `draft`. No se pueden borrar por la
  razón de arriba.
- `createCashInvoice` crea la factura sin `action: send` y después le registra el pago.
  Que HighLevel acepte un pago sobre un borrador no está probado en vivo.
- La detección de membresía en el cotizador exige matrícula, y el campo es **opcional**.
- ~~`PUT /opportunities/{id}` fusiona o reemplaza~~ → **verificado: fusiona.** Ver el
  sondeo de escritura más abajo.
- El `crm_price_map` ya no existe: se fue con Postgres el 7 ago 2026, y las facturas
  llevan los nombres y montos del catálogo propio (que es lo que producción siempre hizo).
- `api/memberships/visits.js` se borró junto con el módulo de membresías sobre Postgres.

## 8. Estado de las pruebas

186 pruebas, todas corren en cualquier máquina: no hay base de datos que preparar.
`npm test`.

Nada de lo descrito en §7 bis está desplegado. **Ya no hace falta aprovisionar nada en
el CRM antes**: el sondeo confirmó que el pipeline, las etapas y los siete campos
existen. Si alguna vez se monta otra subcuenta, `node scripts/setup-membership-fields.mjs`
los crea.

El sondeo de solo lectura vive en `scripts/probe-ghl-recurring.mjs` y se corre con las
credenciales en `.env.probe` (las de Vercel no sirven: están marcadas *Sensitive* y la
CLI las devuelve vacías):

```bash
node --env-file=.env.probe scripts/probe-ghl-recurring.mjs
```
