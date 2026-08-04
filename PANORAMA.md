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
| Membresías | Mensual recurrente | Checkout web | **Dos motores en paralelo — sin resolver** |

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
  ├─ /api/internal/membership-provision ... catálogo en el CRM   (MEMBERSHIP_PROVISION_SECRET)
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
  Postgres, no un `if`.
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
DATABASE_URL=… npm run migrate                       # agrega 003_crm_catalog.sql
node scripts/provision-crm-catalog.mjs               # dry run: 88 productos / 142 precios
node scripts/provision-crm-catalog.mjs --apply       # escribe en el CRM y en el price map
```

Variables nuevas o recién documentadas: `MEMBERSHIP_PROVISION_SECRET`, `DATABASE_SSL_MODE`,
`GHL_VAN_USER_IDS`. Todas en `.env.example`.

Después del `--apply`, archivar a mano los dos productos de depósito viejos en HighLevel.

## 8. Estado de las pruebas

163 pruebas, 152 corren en cualquier máquina y 11 se saltean sin `DATABASE_URL`
(las de Postgres real). `npm test`.

Nada de lo descrito aquí está desplegado.
