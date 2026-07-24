/* ===================================================
   L&B Elite Wash & Detail — Interactive Logic V3
   Dynamic Multi-Step Quoter + Core Page Animations
   =================================================== */

(function () {
  'use strict';

  // ──────────────────────────────────────────────
  // LANGUAGE (bilingual ES / EN)
  // ──────────────────────────────────────────────
  function initialLang() {
    try {
      const saved = localStorage.getItem('lyb-lang');
      if (saved === 'es' || saved === 'en') return saved;
    } catch (e) { /* storage unavailable */ }
    const docLang = document.documentElement.getAttribute('data-lang');
    if (docLang === 'es' || docLang === 'en') return docLang;
    return (navigator.language || 'en').toLowerCase().indexOf('es') === 0 ? 'es' : 'en';
  }
  let LANG = initialLang();

  // Resolve a value that may be a {en, es} object, a plain string, or undefined.
  function loc(v) {
    if (v && typeof v === 'object' && !Array.isArray(v)) return v[LANG] != null ? v[LANG] : v.en;
    return v;
  }
  // UI string by key (filled in by the UI dictionary further below).
  function t(key) {
    const entry = UI_STRINGS[key];
    if (!entry) return key;
    return entry[LANG] != null ? entry[LANG] : entry.en;
  }
  // Single source of truth for the business phone number.
  const PHONE_E164 = '12395270770';
  const PHONE_TEL = '+12395270770';
  const PHONE_DISPLAY = '(239) 527-0770';
  const CAR_HAULER_PACKAGE_IDS = Object.freeze([
    'car-hauler-wash',
    'car-hauler-2x',
    'car-hauler-4x'
  ]);
  // Minutes past midnight → "8am" / "1:30pm".
  function clockLabel(minutes) {
    const hour = Math.floor(minutes / 60);
    const minute = minutes % 60;
    const suffix = hour >= 12 ? 'pm' : 'am';
    const hour12 = hour % 12 === 0 ? 12 : hour % 12;
    return minute ? `${hour12}:${String(minute).padStart(2, '0')}${suffix}` : `${hour12}${suffix}`;
  }

  function minutesFromTime(time) {
    const [hour, minute] = String(time).split(':').map(Number);
    return hour * 60 + minute;
  }

  // "1h 30m" / "2h" — how long the crew is on site for the whole cart.
  function durationLabel(minutes) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (!hours) return `${rest}m`;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
  }

  // Localized label for a stored start time ("08:30") or the full-day key.
  function timeWindowLabel(key) {
    if (!key) return '';
    if (key === 'full_day') return t('tw.full_day');
    const duration = state.availability.durationMinutes || 0;
    const start = minutesFromTime(key);
    return duration ? `${clockLabel(start)}–${clockLabel(start + duration)}` : clockLabel(start);
  }

  // ──────────────────────────────────────────────
  // SERVICES DATA (Extracted from Context & PDF)
  // ──────────────────────────────────────────────
  const SERVICES_DATA = {
    categories: [
      {
        id: 'cars',
        name: 'Cars & SUVs',
        image: 'assets/service-cars.webp',
        from: '$45',
        packages: [
          {
            id: 'basico-exterior',
            name: 'Basic Wash (Lavado Básico)',
            description: 'Lavado exterior profesional realizado con productos de alta calidad y técnicas seguras para la pintura.',
            includes: [
              'Lavado exterior completo',
              'Eliminación de insectos adheridos',
              'Limpieza de cristales exteriores',
              'Limpieza de la tapa del tanque de combustible',
              'Limpieza de llantas y rines',
              'Aplicación de brillo para neumáticos',
              'Secado manual con toallas de microfibra',
              'Limpieza de guardabarros interiores',
              'Inspección final de calidad'
            ],
            prices: {
              sedan: 45,
              suv: 65,
              truck: 85,
              van_pequena: 55,
              van_xl: 75
            }
          },
          {
            id: 'basico-premium',
            name: 'Basic Wash Premium',
            description: 'Combina un lavado exterior profesional con una limpieza interior completa para mantener el vehículo limpio, fresco y protegido.',
            includes: [
              'Aspirado intensivo del interior',
              'Limpieza de tablero y superficies interiores',
              'Limpieza de cristales interiores',
              'Desempolvado completo',
              'Aplicación de ambientador',
              'Lavado exterior completo',
              'Eliminación de insectos adheridos',
              'Limpieza de rines y llantas',
              'Aplicación de brillo para neumáticos',
              'Limpieza de guardabarros interiores',
              'Secado manual con toallas de microfibra'
            ],
            prices: {
              sedan: 75,
              suv: 95,
              truck: 115,
              van_pequena: 100,
              van_xl: 140
            }
          },
          {
            id: 'premium-detail',
            name: 'Premium Detail',
            description: 'Restauración profunda tanto del interior como del exterior del vehículo, brindando una apariencia renovada y una protección superior.',
            includes: [
              'Aspirado intensivo interior',
              'Desempolvado completo interior',
              'Limpieza profunda del tablero',
              'Limpieza de paneles de puertas',
              'Eliminación localizada de olores',
              'Aplicación de máquina de ozono',
              'Limpieza de cristales interiores',
              'Ambientador premium',
              'Lavado exterior completo y eliminación de insectos',
              'Limpieza de rines, llantas y guardabarros',
              'Limpieza del motor',
              'Aplicación de cera manual o sellador en spray',
              'Protección de pintura hasta por 4 meses'
            ],
            prices: {
              sedan: 125,
              suv: 155,
              truck: 195
            }
          },
          {
            id: 'vip',
            name: 'VIP Detail',
            description: 'Nuestro servicio más completo, diseñado para clientes que buscan el máximo nivel de limpieza, restauración y protección.',
            includes: [
              'Limpieza profunda de asientos de cuero, tela o Alcántara',
              'Aspirado intensivo y limpieza del maletero (debe estar vacío)',
              'Limpieza profunda e hidratación de tablero y plásticos',
              'Limpieza e hidratación de paneles de puertas',
              'Tratamiento de olores con máquina de ozono y ambientador premium',
              'Lavado exterior completamente a mano',
              'Detallado profundo de rines y llantas con brillo para neumáticos',
              'Limpieza de guardabarros y tapa de combustible',
              'Limpieza e hidratación del motor',
              'Hidratación de plásticos exteriores',
              'Aplicación de cera manual o sellador premium',
              'Protección de pintura hasta por 6 meses'
            ],
            prices: {
              sedan: 220,
              suv: 250,
              truck: 270
            }
          },
          {
            id: 'membresia-2x',
            name: 'Membresía (2x al mes)',
            description: 'Mantén tu vehículo impecable con 2 visitas premium de mantenimiento mensual.',
            includes: [
              '2 visitas de lavado completo al mes',
              'Aspirado intensivo y desempolvado interior',
              'Limpieza de tablero y cristales',
              'Lavado exterior premium detallado',
              'Programar con al menos 24 horas de anticipación'
            ],
            prices: {
              sedan: 130,
              suv: 160,
              truck: 190,
              van_pequena: 170,
              van_xl: 250
            }
          },
          {
            id: 'membresia-4x',
            name: 'Membresía (4x al mes)',
            description: 'Cuidado semanal absoluto. 4 lavados premium completos al mes.',
            includes: [
              '4 visitas de lavado completo al mes',
              'Aspirado intensivo y desempolvado interior',
              'Limpieza de tablero y cristales',
              'Lavado exterior premium detallado',
              'Programar con al menos 24 horas de anticipación'
            ],
            prices: {
              sedan: 200,
              suv: 260,
              truck: 320,
              van_pequena: 300,
              van_xl: 460
            }
          }
        ],
        sizes: [
          { id: 'sedan', name: 'Sedán / Coupé' },
          { id: 'suv', name: 'SUV & Small Truck' },
          { id: 'truck', name: 'Full-Size Truck' },
          { id: 'van_pequena', name: 'Small Van' },
          { id: 'van_xl', name: 'XL Van' }
        ],
        extras: [
          { id: 'limpieza-motor', name: 'Limpieza de Motor', price: 30, range: 'Desde $30' },
          { id: 'cera-rapida', name: 'Cera Rápida (Spray Wax)', price: 20, range: '$20 - $40' },
          { id: 'sellador-pintura', name: 'Sellador de Pintura', price: 50, range: 'Desde $50' },
          { id: 'pelos-animal', name: 'Eliminación de pelos de mascotas', price: 30, range: '$30 - $140' },
          { id: 'eliminar-olores', name: 'Eliminación de Olores', price: 30, range: '$30 - $100' },
          { id: 'tratamiento-ozono', name: 'Tratamiento con Ozono', price: 40, range: 'Desde $40' },
          { id: 'limpieza-asientos', name: 'Limpieza Profunda de Asientos', price: 40, range: 'Desde $40/fila' },
          { id: 'limpieza-alfombras', name: 'Limpieza de Alfombras y Tapetes', price: 30, range: 'Desde $30' },
          { id: 'restauracion-plasticos', name: 'Restauración de Plásticos', price: 25, range: 'Desde $25' },
          { id: 'pulido-faros', name: 'Pulido de Faros', price: 60, range: 'Desde $60/par' },
          { id: 'descontaminacion-pintura', name: 'Descontaminación de Pintura', price: 60, range: 'Desde $60' },
          { id: 'cargo-bed', name: 'Lavado Compartimiento Carga (Truck Bed)', price: 25, range: 'Desde $25' },
          { id: 'limpieza-chasis', name: 'Limpieza de Chasis', price: 20 }
        ]
      },
      {
        id: 'paint_correction',
        name: 'Paint Correction & Protection',
        image: 'assets/service-paint-correction.webp',
        from: '$299',
        packages: [
          {
            id: 'paint-enhancement',
            name: 'Package 1 – Paint Enhancement',
            description: 'Mejora de brillo de un paso y eliminación de defectos leves con sellador protector.',
            includes: [
              'Lavado premium',
              'Descontaminación química',
              'Clay Bar',
              'Pulido de un paso (mejora brillo y elimina defectos leves)',
              'Aplicación de sellador de pintura (JetSeal)',
              'Limpieza de cristales',
              'Brillo para llantas'
            ],
            prices: {
              sedan: 299,
              suv: 349,
              truck: 399,
              van: 449
            }
          },
          {
            id: 'paint-correction',
            name: 'Package 2 – Paint Correction',
            description: 'Corrección de pintura de dos pasos (compound + polish) para eliminar entre 70-85% de rayones.',
            includes: [
              'Todo lo incluido en el Paquete 1 (Enhancement)',
              'Corrección de pintura de dos pasos (compound + polish)',
              'Eliminación de marcas circulares (swirls) y el 70–85% de rayones',
              'Sellador premium de pintura'
            ],
            prices: {
              sedan: 599,
              suv: 699,
              truck: 799,
              van: 899
            }
          },
          {
            id: 'ceramic-protection',
            name: 'Package 3 – Elite Ceramic Protection',
            description: 'Protección cerámica marina/vial de alta resistencia para un acabado de espejo duradero.',
            includes: [
              'Lavado premium y descontaminación completa',
              'Clay Bar y Corrección de pintura',
              'Preparación con panel wipe',
              'Aplicación de recubrimiento cerámico',
              'Protección UV y alto brillo',
              'Efecto hidrofóbico extremo (repelencia al agua)'
            ],
            prices: {
              sedan: 999,
              suv: 1199,
              truck: 1399,
              van: 1599
            }
          }
        ],
        sizes: [
          { id: 'sedan', name: 'Sedán' },
          { id: 'suv', name: 'SUV' },
          { id: 'truck', name: 'Pickup / Truck' },
          { id: 'van', name: 'Van' }
        ],
        extras: [
          { id: 'faros-recup', name: 'Restauración de faros', price: 120 },
          { id: 'tar-sap', name: 'Remoción de alquitrán y savia', price: 50, range: 'Desde $50' },
          { id: 'water-spots', name: 'Eliminación de manchas de agua', price: 75, range: 'Desde $75' },
          { id: 'engine-bay', name: 'Limpieza del compartimiento del motor', price: 75 },
          { id: 'ext-plastics', name: 'Protección de plásticos exteriores', price: 50 },
          { id: 'repelente-cristales', name: 'Tratamiento de cristales repelente', price: 50 }
        ]
      },
      {
        id: 'heavy_trucks',
        name: 'Heavy Trucks',
        image: 'assets/service-heavy-trucks.webp',
        from: '$80',
        packages: [
          {
            id: 'box-truck-wash',
            name: 'Box Truck (Basic Wash)',
            description: 'Lavado exterior manual completo para camiones de carga de diferentes medidas.',
            includes: [
              'Lavado exterior completo',
              'Aplicación de jabón profesional',
              'Lavado manual con cepillos y/o guantes de microfibra',
              'Limpieza de espejos y cristales',
              'Limpieza básica de rines y llantas',
              'Desengrasado ligero y enjuague completo',
              'Secado de superficies visibles'
            ],
            prices: {
              size_10_16: 80,
              size_17_20: 100,
              size_21_26: 140
            }
          },
          {
            id: 'box-truck-2x',
            name: 'Box Truck Membresía (2x al mes)',
            description: 'Mantenimiento quincenal para mantener la imagen limpia de tu camión.',
            includes: [
              '2 visitas de lavado exterior completo al mes',
              'Remoción de grasa y lavado manual',
              'Limpieza de cristales y espejos'
            ],
            prices: {
              size_10_16: 140,
              size_17_20: 170,
              size_21_26: 250
            }
          },
          {
            id: 'box-truck-4x',
            name: 'Box Truck Membresía (4x al mes)',
            description: 'Limpieza semanal intensiva para flotas de camiones de carga.',
            includes: [
              '4 visitas de lavado exterior completo al mes',
              'Remoción de grasa y lavado manual',
              'Limpieza de cristales y espejos'
            ],
            prices: {
              size_10_16: 240,
              size_17_20: 300,
              size_21_26: 440
            }
          },
          {
            id: 'semi-truck-wash',
            name: 'Semi Truck (Tractor) Wash',
            description: 'Lavado completo exterior para cabezal de tractocamión.',
            includes: [
              'Lavado exterior completo',
              'Limpieza de cabina exterior',
              'Limpieza de cristales y espejos',
              'Limpieza básica de rines y neumáticos',
              'Desengrasado ligero y secado'
            ],
            prices: {
              standard: 150
            }
          },
          {
            id: 'semi-truck-2x',
            name: 'Semi Truck Membresía (2x al mes)',
            description: 'Mantenimiento quincenal recurrente para tractores.',
            includes: [
              '2 visitas de lavado exterior completo de Semi Truck al mes',
              'Limpieza exterior de cabina, cristales y rines'
            ],
            prices: {
              standard: 270
            }
          },
          {
            id: 'semi-truck-4x',
            name: 'Semi Truck Membresía (4x al mes)',
            description: 'Limpieza semanal intensiva para cabezales de tractocamión.',
            includes: [
              '4 visitas de lavado exterior completo de Semi Truck al mes',
              'Limpieza exterior de cabina, cristales y rines'
            ],
            prices: {
              standard: 500
            }
          },
          {
            id: 'trailer-wash',
            name: 'Trailer Wash (Reefer / Dry Van)',
            description: 'Lavado completo a presión de paneles de trailer comercial de 48\' a 53\'.',
            includes: [
              'Lavado exterior completo',
              'Eliminación de suciedad acumulada de carretera',
              'Limpieza de paneles laterales, frontal y posterior',
              'Enjuague completo y secado'
            ],
            prices: {
              standard: 200
            }
          },
          {
            id: 'trailer-2x',
            name: 'Trailer Membresía (2x al mes)',
            description: '2 visitas mensuales de lavado exterior de trailer.',
            includes: [
              '2 lavados exteriores completos al mes',
              'Limpieza de paneles, frontal y posterior'
            ],
            prices: {
              standard: 370
            }
          },
          {
            id: 'trailer-4x',
            name: 'Trailer Membresía (4x al mes)',
            description: 'Lavado exterior semanal recurrente para trailers comerciales.',
            includes: [
              '4 lavados exteriores completos al mes',
              'Limpieza de paneles, frontal y posterior'
            ],
            prices: {
              standard: 700
            }
          },
          {
            id: 'car-hauler-wash',
            name: 'Car Hauler (Lavado Básico)',
            description: 'Lavado completo únicamente del remolque transportador de vehículos; no incluye el camión tractor. Atención especial a chasis, estructura, rampas y plataformas.',
            includes: [
              'Desengrasado de chasis y estructura',
              'Lavado completo con champú para vehículos comerciales',
              'Limpieza de rines y llantas',
              'Lavado de guardabarros',
              'Enjuague a presión',
              'Secado para evitar manchas',
              'Aplicación de brillo para neumáticos',
              'Desengrasado profundo de rampas y plataformas'
            ],
            prices: {
              standard: 120
            }
          },
          {
            id: 'car-hauler-2x',
            name: 'Car Hauler Membresía (2x al mes)',
            description: 'Dos lavados mensuales completos del remolque transportador de vehículos; no incluyen el camión tractor.',
            includes: [
              '2 lavados básicos completos al mes',
              'Desengrasado de chasis, estructura, rampas y plataformas',
              'Lavado con champú para vehículos comerciales',
              'Limpieza de rines, llantas y guardabarros',
              'Enjuague a presión',
              'Secado para evitar manchas',
              'Aplicación de brillo para neumáticos'
            ],
            prices: {
              standard: 220
            }
          },
          {
            id: 'car-hauler-4x',
            name: 'Car Hauler Membresía (4x al mes)',
            description: 'Lavado semanal recurrente del remolque transportador de vehículos; no incluye el camión tractor.',
            includes: [
              '4 lavados básicos completos al mes',
              'Desengrasado de chasis, estructura, rampas y plataformas',
              'Lavado con champú para vehículos comerciales',
              'Limpieza de rines, llantas y guardabarros',
              'Enjuague a presión',
              'Secado para evitar manchas',
              'Aplicación de brillo para neumáticos'
            ],
            prices: {
              standard: 400
            }
          },
          {
            id: 'dump-truck-wash',
            name: 'Dump Truck (Camión de Volteo)',
            description: 'Lavado exterior para camiones de volteo incluyendo chasis visible y tolva.',
            includes: [
              'Lavado exterior completo',
              'Eliminación de barro y suciedad de chasis visible',
              'Limpieza de rines y neumáticos',
              'Desengrasado ligero'
            ],
            prices: {
              standard: 180
            }
          },
          {
            id: 'dump-truck-2x',
            name: 'Dump Truck Membresía (2x al mes)',
            description: '2 visitas mensuales de lavado exterior de camión de volteo.',
            includes: [
              '2 lavados completos exteriores y de chasis al mes'
            ],
            prices: {
              standard: 320
            }
          },
          {
            id: 'dump-truck-4x',
            name: 'Dump Truck Membresía (4x al mes)',
            description: 'Lavado exterior semanal recurrente para camiones de volteo.',
            includes: [
              '4 lavados completos exteriores y de chasis al mes'
            ],
            prices: {
              standard: 620
            }
          },
          {
            id: 'garbage-truck-wash',
            name: 'Garbage Truck (Camión de Basura)',
            description: 'Lavado y desengrasado exterior de alta resistencia.',
            includes: [
              'Lavado exterior',
              'Desengrasado básico',
              'Eliminación de suciedad pesada',
              'Limpieza de cabina y cristales',
              'Enjuague completo'
            ],
            prices: {
              standard: 200
            }
          },
          {
            id: 'garbage-truck-2x',
            name: 'Garbage Truck Membresía (2x al mes)',
            description: '2 visitas mensuales de lavado exterior de camión de basura.',
            includes: [
              '2 lavados exteriores y desengrasados de chasis/caja al mes'
            ],
            prices: {
              standard: 370
            }
          },
          {
            id: 'garbage-truck-4x',
            name: 'Garbage Truck Membresía (4x al mes)',
            description: 'Lavado exterior semanal recurrente para camiones de basura.',
            includes: [
              '4 lavados exteriores y desengrasados de chasis/caja al mes'
            ],
            prices: {
              standard: 700
            }
          }
        ],
        sizes: [
          { id: 'size_10_16', name: 'Caja de 10\' a 16\'' },
          { id: 'size_17_20', name: 'Caja de 17\' a 20\'' },
          { id: 'size_21_26', name: 'Caja de 21\' a 26\'' },
          { id: 'standard', name: 'Medida Estándar' }
        ],
        extras: [
          { id: 'limpieza-cabina', name: 'Limpieza Interior de Cabina', price: 25, range: '$25 - $60' },
          { id: 'cera-rapida', name: 'Cera Rápida', price: 20, range: '$20 - $40' },
          { id: 'desengrasado-profundo', name: 'Desengrasado Profundo', price: 30, range: '$30 - $60' },
          { id: 'engrasado-camion', name: 'Engrasado para Camiones', price: 50 },
          { id: 'motor-pesado', name: 'Limpieza de Motor', price: 30 },
          { id: 'volteo-aluminio', name: 'Caja de Aluminio', price: 120, onlyFor: ['dump-truck-wash', 'dump-truck-2x', 'dump-truck-4x'] },
          { id: 'rines-aluminio', name: 'Ácido para Rines de Aluminio', price: 25 },
          { id: 'pulido-rines-llantas', name: 'Pulido de Rines y Llantas', price: 25 },
          { id: 'car-hauler-second-deck', name: 'Lavado del Segundo Piso', price: 100, onlyFor: CAR_HAULER_PACKAGE_IDS },
          { id: 'lubricante-grafito', name: 'Lubricante de Grafito', priceByPackage: { 'car-hauler-wash': 60, 'car-hauler-2x': 100, 'car-hauler-4x': 220 }, onlyFor: CAR_HAULER_PACKAGE_IDS },
          { id: 'pulido-tanques', name: 'Pulido Tanques de Aluminio (Cotiz.)', price: 0, range: 'Cotización personalizada' }
        ]
      },
      {
        id: 'boats',
        name: 'Boats & Watercraft',
        image: 'assets/service-boats.webp',
        from: '$120',
        packages: [
          {
            id: 'boat-basico',
            name: 'Basic Boat Wash',
            description: 'Servicio de lavado básico diseñado para mantener la embarcación limpia después de cada uso.',
            includes: [
              'Lavado completo del exterior',
              'Enjuague con agua dulce',
              'Eliminación de sal, arena y suciedad',
              'Limpieza básica del casco',
              'Limpieza de superficies visibles',
              'Secado básico'
            ],
            prices: {
              boat_16_20: 120,
              boat_21_30: 170,
              boat_31_40: 220,
              boat_41_60: 300
            }
          },
          {
            id: 'boat-premium',
            name: 'Premium Boat Wash',
            description: 'Limpieza más completa tanto del exterior como del interior detallado.',
            includes: [
              'Lavado completo exterior y enjuague dulce',
              'Eliminación de sal y suciedad',
              'Limpieza detallada del casco',
              'Limpieza detallada de asientos interior',
              'Limpieza de consola y ventanas',
              'Limpieza de compartimientos y superficies visibles'
            ],
            prices: {
              boat_16_20: 180,
              boat_21_30: 250,
              boat_31_40: 400,
              boat_41_60: 600
            },
            priceRanges: {
              boat_16_20: '$180 - $250',
              boat_21_30: '$250 - $400',
              boat_31_40: '$400 - $600',
              boat_41_60: '$600 - $900'
            }
          },
          {
            id: 'boat-detail',
            name: 'Premium Boat Detail',
            description: 'Nuestro servicio más completo para restaurar y proteger su embarcación marina.',
            includes: [
              'Limpieza interior completa',
              'Limpieza exterior completa',
              'Pulido del casco y restauración del brillo',
              'Aplicación de protectores para superficies',
              'Limpieza de detalles y acabado profesional'
            ],
            prices: {
              boat_16_20: 250,
              boat_21_30: 400,
              boat_31_40: 600,
              boat_41_60: 900
            },
            priceRanges: {
              boat_16_20: '$250 - $400',
              boat_21_30: '$400 - $600',
              boat_31_40: '$600 - $900',
              boat_41_60: '$900 - $1,200'
            }
          }
        ],
        sizes: [
          { id: 'boat_16_20', name: '16 FT a 20 FT' },
          { id: 'boat_21_30', name: '21 FT a 30 FT' },
          { id: 'boat_31_40', name: '31 FT a 40 FT' },
          { id: 'boat_41_60', name: '41 FT a 60 FT' }
        ],
        extras: [
          { id: 'boat-motor', name: 'Limpieza y detallado del motor', price: 75, range: 'Desde $75' },
          { id: 'boat-vinilo-uv', name: 'Limpieza profunda y protección UV de asientos de vinilo', price: 100, range: 'Desde $100' },
          { id: 'boat-cera-marina', name: 'Aplicación de cera marina premium', price: 20, range: '$20/pie' },
          { id: 'boat-pulido', name: 'Pulido de una etapa', price: 30, range: '$30/pie' },
          { id: 'boat-oxidacion', name: 'Eliminación de oxidación', price: 35, range: 'Desde $35/pie' },
          { id: 'boat-ceramica', name: 'Recubrimiento cerámico marino', price: 75, range: 'Desde $75/pie' },
          { id: 'boat-inox', name: 'Pulido de acero inoxidable y cromados', price: 100 },
          { id: 'boat-compartimientos', name: 'Limpieza de compartimientos y áreas de almacenamiento', price: 75 },
          { id: 'boat-manchas-agua', name: 'Eliminación de manchas de agua', price: 75, range: 'Desde $75' },
          { id: 'boat-marcas-casco', name: 'Eliminación de marcas negras del casco', price: 60, range: 'Desde $60' },
          { id: 'boat-lona-bimini', name: 'Limpieza de lona, Bimini Top o T-Top', price: 100, range: 'Desde $100' },
          { id: 'boat-repelente-cristales', name: 'Tratamiento repelente de agua para cristales', price: 75 },
          { id: 'boat-olores-ozono', name: 'Eliminación de olores y tratamiento con ozono', price: 100 },
          { id: 'boat-teca', name: 'Limpieza y restauración de teca (Teak)', price: 25, range: 'Desde $25/pie' }
        ]
      },
      {
        id: 'jetski',
        name: 'Jet Ski',
        image: 'assets/service-jetski.webp',
        from: '$80',
        packages: [
          {
            id: 'jetski-premium',
            name: 'Premium Wash Jet Ski',
            description: 'Lavado completo del Jet Ski, tráiler y remoción total de salitre.',
            includes: [
              'Lavado completo del Jet Ski y del tráiler',
              'Enjuague con agua dulce',
              'Eliminación de sal y arena',
              'Limpieza de casco y asiento',
              'Secado completo'
            ],
            prices: {
              qty_1: 80,
              qty_2: 150,
              qty_3: 200
            }
          },
          {
            id: 'jetski-membresia',
            name: 'Membresía (2x al mes)',
            description: 'Mantenimiento quincenal continuo para mantener tu moto náutica lista.',
            includes: [
              '2 visitas de lavado completo premium al mes',
              'Lavado del tráiler y enjuague dulce',
              'Eliminación de salitre'
            ],
            prices: {
              qty_1: 130,
              qty_2: 220,
              qty_3: 300
            }
          }
        ],
        sizes: [
          { id: 'qty_1', name: '1 Jet Ski' },
          { id: 'qty_2', name: '2 Jet Skis' },
          { id: 'qty_3', name: '3 Jet Skis' }
        ],
        extras: [
          { id: 'eliminacion-sal', name: 'Descontaminación por sal pesada', price: 20 },
          { id: 'brillo-plasticos', name: 'Restauración de brillo en plásticos', price: 15 },
          { id: 'limpieza-asiento', name: 'Limpieza profunda de asiento', price: 30 },
          { id: 'ceramica-marina', name: 'Cerámica rápida marina', price: 35 }
        ]
      },
      {
        id: 'golf_cart',
        name: 'Golf Cart',
        image: 'assets/service-golf-cart.webp',
        from: '$80',
        packages: [
          {
            id: 'golf-premium',
            name: 'Premium Wash Golf Cart',
            description: 'Lavado detallado completo incluyendo asientos, volante, techo y ruedas.',
            includes: [
              'Lavado exterior completo y limpieza de techo',
              'Limpieza de asientos, volante y tablero',
              'Limpieza de ruedas y rines',
              'Limpieza interior y secado detallado'
            ],
            prices: {
              standard: 80
            }
          },
          {
            id: 'golf-membresia',
            name: 'Membresía (2x al mes)',
            description: 'Mantenimiento mensual recurrente (2 visitas por mes) de tu carrito de golf.',
            includes: [
              '2 visitas de lavado completo premium al mes',
              'Limpieza de asientos, tablero, ruedas y volante',
              'Secado detallado'
            ],
            prices: {
              standard: 130
            }
          }
        ],
        sizes: [
          { id: 'standard', name: 'Estándar' }
        ],
        extras: []
      },
      {
        id: 'atv',
        name: 'ATVs & Quad',
        image: 'assets/service-atv.webp',
        from: '$100',
        packages: [
          {
            id: 'atv-premium',
            name: 'Premium Wash ATV',
            description: 'Eliminación a presión de barro, arena, polvo y grasa; detallado de partes mecánicas visibles.',
            includes: [
              'Lavado a presión',
              'Eliminación de barro, arena y polvo',
              'Limpieza de suspensión visible',
              'Limpieza de ruedas y rines',
              'Limpieza de asiento y guardabarros',
              'Limpieza de luces y manillares',
              'Secado detallado'
            ],
            prices: {
              qty_1: 100,
              qty_2: 170,
              qty_3: 220
            }
          },
          {
            id: 'atv-membresia',
            name: 'Membresía (2x al mes)',
            description: '2 visitas al mes para mantener limpia tu cuatrimoto después de tus aventuras.',
            includes: [
              '2 visitas de lavado a presión detallado al mes',
              'Limpieza de suspensión, guardabarros y plásticos'
            ],
            prices: {
              qty_1: 170,
              qty_2: 280,
              qty_3: 400
            }
          }
        ],
        sizes: [
          { id: 'qty_1', name: '1 ATV' },
          { id: 'qty_2', name: '2 ATVs' },
          { id: 'qty_3', name: '3 ATVs' }
        ],
        extras: []
      },
      {
        id: 'mobile_home',
        name: 'Mobile Homes',
        image: 'assets/service-mobile-home.webp',
        from: '$150',
        packages: [
          {
            id: 'mobile-home-basico',
            name: 'Basic Premium Wash',
            description: 'Lavado profesional exterior soft-wash para casas móviles. Elimina moho y suciedad.',
            includes: [
              'Lavado exterior completo',
              'Aplicación de técnica Soft Wash o baja presión (según el material)',
              'Eliminación de moho, algas y hongos',
              'Eliminación de suciedad acumulada y telarañas',
              'Enjuague completo e inspección final de calidad'
            ],
            prices: {
              single_wide: 150,
              double_wide: 225,
              triple_wide: 350
            },
            priceRanges: {
              single_wide: '$150 - $225',
              double_wide: '$225 - $350',
              triple_wide: '$350 - $500'
            }
          }
        ],
        sizes: [
          { id: 'single_wide', name: 'Single-Wide (1 Sección)' },
          { id: 'double_wide', name: 'Double-Wide (2 Secciones)' },
          { id: 'triple_wide', name: 'Triple-Wide o Mayor' }
        ],
        extras: []
      },
      {
        id: 'driveway',
        name: 'Driveways',
        image: 'assets/service-driveway.webp',
        from: '$100',
        packages: [
          {
            id: 'driveway-basico',
            name: 'Basic Pressure Wash',
            description: 'El método más eficiente para la limpieza de superficies de concreto y pavimento.',
            includes: [
              'Lavado a presión profesional',
              'Eliminación de suciedad, moho y algas',
              'Eliminación de polvo y enjuague completo',
              'Inspección final de calidad'
            ],
            prices: {
              standard: 100
            },
            priceRanges: {
              standard: '$100 - $300'
            }
          },
          {
            id: 'driveway-premium',
            name: 'Premium Pressure Wash',
            description: 'Recomendado para concreto con manchas difíciles, aceite de motor y fluidos.',
            includes: [
              'Todo lo incluido en el Basic Pressure Wash',
              'Aplicación de desengrasantes profesionales',
              'Tratamiento especializado para manchas de aceite',
              'Eliminación de pintura superficial y fluidos automotrices',
              'Productos especializados para restaurar la superficie'
            ],
            prices: {
              standard: 150
            },
            priceRanges: {
              standard: '$150 - $400'
            }
          }
        ],
        sizes: [
          { id: 'standard', name: 'Estándar' }
        ],
        extras: []
      }
    ]
  };

  // English copy maps live inside this setup function; the original Spanish lives
  // in SERVICES_DATA. We snapshot Spanish, keep English, and expose both so
  // applyServiceLanguage() can swap the live fields on demand.
  let SERVICE_COPY_EN = null, SERVICE_COPY_ES = null;
  function setupBilingualServiceCopy() {
    const categoryCopy = {
      cars: {
        name: 'Cars & SUVs',
        sizes: {
          sedan: 'Sedan / Coupe',
          suv: 'SUV & Small Truck',
          truck: 'Full-Size Truck',
          van_pequena: 'Small Van',
          van_xl: 'XL Van'
        },
        extras: {
          'limpieza-motor': ['Engine Bay Cleaning', 'From $30'],
          'cera-rapida': ['Quick Spray Wax', '$20 - $40'],
          'sellador-pintura': ['Paint Sealant', 'From $50'],
          'pelos-animal': ['Pet Hair Removal', '$30 - $140'],
          'eliminar-olores': ['Odor Removal', '$30 - $100'],
          'tratamiento-ozono': ['Ozone Treatment', 'From $40'],
          'limpieza-asientos': ['Deep Seat Cleaning', 'From $40/row'],
          'limpieza-alfombras': ['Carpet and Mat Cleaning', 'From $30'],
          'restauracion-plasticos': ['Plastic Trim Restoration', 'From $25'],
          'pulido-faros': ['Headlight Polishing', 'From $60/pair'],
          'descontaminacion-pintura': ['Paint Decontamination', 'From $60'],
          'cargo-bed': ['Truck Bed Wash', 'From $25'],
          'limpieza-chasis': ['Chassis Cleaning']
        }
      },
      paint_correction: {
        name: 'Paint Correction & Protection',
        sizes: {
          sedan: 'Sedan',
          suv: 'SUV',
          truck: 'Pickup / Truck',
          van: 'Van'
        },
        extras: {
          'faros-recup': ['Headlight Restoration'],
          'tar-sap': ['Tar and Sap Removal', 'From $50'],
          'water-spots': ['Water Spot Removal', 'From $75'],
          'engine-bay': ['Engine Bay Cleaning'],
          'ext-plastics': ['Exterior Plastic Protection'],
          'repelente-cristales': ['Glass Water-Repellent Treatment']
        }
      },
      heavy_trucks: {
        name: 'Heavy Trucks',
        sizes: {
          size_10_16: "10' to 16' Box",
          size_17_20: "17' to 20' Box",
          size_21_26: "21' to 26' Box",
          standard: 'Standard Size'
        },
        extras: {
          'limpieza-cabina': ['Interior Cab Cleaning', '$25 - $60'],
          'cera-rapida': ['Quick Wax', '$20 - $40'],
          'desengrasado-profundo': ['Deep Degreasing', '$30 - $60'],
          'engrasado-camion': ['Truck Chassis Greasing'],
          'motor-pesado': ['Engine Cleaning'],
          'volteo-aluminio': ['Aluminum Dump Bed'],
          'rines-aluminio': ['Aluminum Wheel Acid Cleaning'],
          'pulido-rines-llantas': ['Wheel and Tire Polishing'],
          'car-hauler-second-deck': ['Second-Deck Wash'],
          'lubricante-grafito': ['Dry Graphite Lubricant'],
          'pulido-tanques': ['Aluminum Tank Polishing (Quote)', 'Custom quote']
        }
      },
      boats: {
        name: 'Boats & Watercraft',
        sizes: {
          boat_16_20: '16 FT to 20 FT',
          boat_21_30: '21 FT to 30 FT',
          boat_31_40: '31 FT to 40 FT',
          boat_41_60: '41 FT to 60 FT'
        },
        extras: {
          'boat-motor': ['Engine Cleaning & Detailing', 'From $75'],
          'boat-vinilo-uv': ['Deep Vinyl Seat Cleaning & UV Protection', 'From $100'],
          'boat-cera-marina': ['Premium Marine Wax Application', '$20/ft'],
          'boat-pulido': ['One-Stage Polish', '$30/ft'],
          'boat-oxidacion': ['Oxidation Removal', 'From $35/ft'],
          'boat-ceramica': ['Marine Ceramic Coating', 'From $75/ft'],
          'boat-inox': ['Stainless Steel & Chrome Polishing'],
          'boat-compartimientos': ['Compartment & Storage Area Cleaning'],
          'boat-manchas-agua': ['Water Spot Removal', 'From $75'],
          'boat-marcas-casco': ['Hull Black Streak Removal', 'From $60'],
          'boat-lona-bimini': ['Canvas, Bimini Top or T-Top Cleaning', 'From $100'],
          'boat-repelente-cristales': ['Glass Water-Repellent Treatment'],
          'boat-olores-ozono': ['Odor Removal & Ozone Treatment'],
          'boat-teca': ['Teak Cleaning & Restoration', 'From $25/ft']
        }
      },
      jetski: {
        name: 'Jet Ski',
        sizes: {
          qty_1: '1 Jet Ski',
          qty_2: '2 Jet Skis',
          qty_3: '3 Jet Skis'
        },
        extras: {
          'eliminacion-sal': ['Heavy Salt Decontamination'],
          'brillo-plasticos': ['Plastic Gloss Restoration'],
          'limpieza-asiento': ['Deep Seat Cleaning'],
          'ceramica-marina': ['Quick Marine Ceramic']
        }
      },
      golf_cart: {
        name: 'Golf Cart',
        sizes: { standard: 'Standard' }
      },
      atv: {
        name: 'ATVs & Quad',
        sizes: {
          qty_1: '1 ATV',
          qty_2: '2 ATVs',
          qty_3: '3 ATVs'
        }
      },
      mobile_home: {
        name: 'Mobile Homes',
        sizes: {
          single_wide: 'Single-Wide (1 Section)',
          double_wide: 'Double-Wide (2 Sections)',
          triple_wide: 'Triple-Wide or Larger'
        }
      },
      driveway: {
        name: 'Driveways & Patios',
        sizes: { standard: 'Standard' }
      }
    };

    const packageCopy = {
      'basico-exterior': {
        name: 'Basic Exterior Wash',
        description: 'Professional exterior wash using paint-safe techniques and high-quality products.',
        includes: ['Complete exterior wash', 'Bug removal', 'Exterior glass cleaning', 'Fuel door cleaning', 'Wheel and tire cleaning', 'Tire shine application', 'Microfiber towel dry', 'Inner fender cleaning', 'Final quality inspection']
      },
      'basico-premium': {
        name: 'Basic Premium Wash',
        description: 'Exterior wash plus a complete interior refresh to keep the vehicle clean, fresh, and protected.',
        includes: ['Intensive interior vacuum', 'Dashboard and interior surface cleaning', 'Interior glass cleaning', 'Complete dust removal', 'Premium air freshener', 'Complete exterior wash', 'Bug removal', 'Wheel and tire cleaning', 'Tire shine application', 'Inner fender cleaning', 'Microfiber towel dry']
      },
      'premium-detail': {
        name: 'Premium Detail',
        description: 'Deep interior and exterior restoration for a refreshed look and stronger surface protection.',
        includes: ['Intensive interior vacuum', 'Complete interior dust removal', 'Deep dashboard cleaning', 'Door panel cleaning', 'Localized odor removal', 'Ozone machine treatment', 'Interior glass cleaning', 'Premium air freshener', 'Complete exterior wash and bug removal', 'Wheel, tire, and fender cleaning', 'Engine bay cleaning', 'Hand wax or spray sealant', 'Paint protection up to 4 months']
      },
      vip: {
        name: 'VIP Detail',
        description: 'Our most complete service for customers who want the highest level of cleaning, restoration, and protection.',
        includes: ['Deep cleaning for leather, fabric, or Alcantara seats', 'Intensive vacuum and empty trunk cleaning', 'Deep dashboard and plastic conditioning', 'Door panel cleaning and conditioning', 'Ozone odor treatment and premium air freshener', 'Full hand exterior wash', 'Deep wheel and tire detailing with tire shine', 'Fender and fuel door cleaning', 'Engine bay cleaning and conditioning', 'Exterior plastic conditioning', 'Hand wax or premium sealant', 'Paint protection up to 6 months']
      },
      'membresia-2x': {
        name: 'Membership (2x per month)',
        description: 'Two monthly premium maintenance visits to keep your vehicle consistently clean.',
        includes: ['2 complete wash visits per month', 'Intensive vacuum and interior dust removal', 'Dashboard and glass cleaning', 'Premium detailed exterior wash', 'Schedule at least 24 hours in advance']
      },
      'membresia-4x': {
        name: 'Membership (4x per month)',
        description: 'Weekly premium care with four complete washes per month.',
        includes: ['4 complete wash visits per month', 'Intensive vacuum and interior dust removal', 'Dashboard and glass cleaning', 'Premium detailed exterior wash', 'Schedule at least 24 hours in advance']
      },
      'paint-enhancement': {
        name: 'Package 1 - Paint Enhancement',
        description: 'One-step gloss enhancement with light defect removal and protective sealant.',
        includes: ['Premium wash', 'Chemical decontamination', 'Clay bar treatment', 'One-step polish for gloss and light defects', 'Paint sealant application (JetSeal)', 'Glass cleaning', 'Tire shine']
      },
      'paint-correction': {
        name: 'Package 2 - Paint Correction',
        description: 'Two-step correction with compound and polish to remove 70-85% of swirls and scratches.',
        includes: ['Everything in Package 1', 'Two-step paint correction with compound and polish', 'Swirl mark removal and 70-85% scratch reduction', 'Premium paint sealant']
      },
      'ceramic-protection': {
        name: 'Package 3 - Elite Ceramic Protection',
        description: 'High-gloss ceramic protection for long-lasting shine, UV defense, and hydrophobic performance.',
        includes: ['Premium wash and full decontamination', 'Clay bar and paint correction', 'Panel wipe preparation', 'Ceramic coating application', 'UV protection and high gloss', 'Extreme hydrophobic water behavior']
      },
      'box-truck-wash': {
        name: 'Box Truck Basic Wash',
        description: 'Complete manual exterior wash for commercial box trucks in multiple sizes.',
        includes: ['Complete exterior wash', 'Professional soap application', 'Manual wash with brushes or microfiber mitts', 'Mirror and glass cleaning', 'Basic wheel and tire cleaning', 'Light degreasing and complete rinse', 'Visible surface drying']
      },
      'box-truck-2x': {
        name: 'Box Truck Membership (2x per month)',
        description: 'Biweekly maintenance to keep your commercial truck clean and presentable.',
        includes: ['2 complete exterior wash visits per month', 'Grease removal and manual washing', 'Glass and mirror cleaning']
      },
      'box-truck-4x': {
        name: 'Box Truck Membership (4x per month)',
        description: 'Weekly exterior cleaning for active commercial fleets.',
        includes: ['4 complete exterior wash visits per month', 'Grease removal and manual washing', 'Glass and mirror cleaning']
      },
      'semi-truck-wash': {
        name: 'Semi Truck Tractor Wash',
        description: 'Complete exterior wash for tractor units.',
        includes: ['Complete exterior wash', 'Exterior cab cleaning', 'Glass and mirror cleaning', 'Basic wheel and tire cleaning', 'Light degreasing and drying']
      },
      'semi-truck-2x': {
        name: 'Semi Truck Membership (2x per month)',
        description: 'Biweekly recurring maintenance for tractor units.',
        includes: ['2 complete semi truck exterior washes per month', 'Exterior cab, glass, and wheel cleaning']
      },
      'semi-truck-4x': {
        name: 'Semi Truck Membership (4x per month)',
        description: 'Weekly recurring exterior cleaning for semi truck tractors.',
        includes: ['4 complete semi truck exterior washes per month', 'Exterior cab, glass, and wheel cleaning']
      },
      'trailer-wash': {
        name: 'Trailer Wash (Reefer / Dry Van)',
        description: "Complete pressure wash for 48' to 53' commercial trailer panels.",
        includes: ['Complete exterior wash', 'Road grime removal', 'Side, front, and rear panel cleaning', 'Complete rinse and drying']
      },
      'trailer-2x': {
        name: 'Trailer Membership (2x per month)',
        description: 'Two monthly exterior trailer washes.',
        includes: ['2 complete exterior washes per month', 'Side, front, and rear panel cleaning']
      },
      'trailer-4x': {
        name: 'Trailer Membership (4x per month)',
        description: 'Weekly recurring exterior washing for commercial trailers.',
        includes: ['4 complete exterior washes per month', 'Side, front, and rear panel cleaning']
      },
      'car-hauler-wash': {
        name: 'Car Hauler Basic Wash',
        description: 'Complete wash of the auto-transport trailer only; the tractor truck is not included. Special attention is given to the chassis, structure, ramps, and platforms.',
        includes: ['Chassis and structure degreasing', 'Complete wash with commercial vehicle shampoo', 'Wheel and tire cleaning', 'Fender cleaning', 'Pressure rinse', 'Spot-prevention drying', 'Tire shine application', 'Deep degreasing of ramps and platforms']
      },
      'car-hauler-2x': {
        name: 'Car Hauler Membership (2x per month)',
        description: 'Two complete monthly washes of the auto-transport trailer; the tractor truck is not included.',
        includes: ['2 complete basic washes per month', 'Chassis, structure, ramp, and platform degreasing', 'Commercial vehicle shampoo wash', 'Wheel, tire, and fender cleaning', 'Pressure rinse', 'Spot-prevention drying', 'Tire shine application']
      },
      'car-hauler-4x': {
        name: 'Car Hauler Membership (4x per month)',
        description: 'Recurring weekly washing of the auto-transport trailer; the tractor truck is not included.',
        includes: ['4 complete basic washes per month', 'Chassis, structure, ramp, and platform degreasing', 'Commercial vehicle shampoo wash', 'Wheel, tire, and fender cleaning', 'Pressure rinse', 'Spot-prevention drying', 'Tire shine application']
      },
      'dump-truck-wash': {
        name: 'Dump Truck Wash',
        description: 'Exterior wash for dump trucks including visible chassis and dump bed areas.',
        includes: ['Complete exterior wash', 'Mud and grime removal from visible chassis', 'Wheel and tire cleaning', 'Light degreasing']
      },
      'dump-truck-2x': {
        name: 'Dump Truck Membership (2x per month)',
        description: 'Two monthly exterior dump truck washes.',
        includes: ['2 complete exterior and chassis washes per month']
      },
      'dump-truck-4x': {
        name: 'Dump Truck Membership (4x per month)',
        description: 'Weekly recurring exterior washing for dump trucks.',
        includes: ['4 complete exterior and chassis washes per month']
      },
      'garbage-truck-wash': {
        name: 'Garbage Truck Wash',
        description: 'Heavy-duty exterior wash and degreasing.',
        includes: ['Exterior wash', 'Basic degreasing', 'Heavy dirt removal', 'Cab and glass cleaning', 'Complete rinse']
      },
      'garbage-truck-2x': {
        name: 'Garbage Truck Membership (2x per month)',
        description: 'Two monthly garbage truck exterior washes.',
        includes: ['2 exterior washes and chassis/body degreasing services per month']
      },
      'garbage-truck-4x': {
        name: 'Garbage Truck Membership (4x per month)',
        description: 'Weekly recurring exterior washing for garbage trucks.',
        includes: ['4 exterior washes and chassis/body degreasing services per month']
      },
      'boat-basico': {
        name: 'Basic Boat Wash',
        description: 'Basic wash service designed to keep the boat clean after each use.',
        includes: ['Complete exterior wash', 'Freshwater rinse', 'Salt, sand, and dirt removal', 'Basic hull cleaning', 'Visible surface cleaning', 'Basic drying']
      },
      'boat-premium': {
        name: 'Premium Boat Wash',
        description: 'A more complete exterior and interior marine cleaning service.',
        includes: ['Complete exterior wash and freshwater rinse', 'Salt and grime removal', 'Detailed hull cleaning', 'Detailed interior seat cleaning', 'Console and window cleaning', 'Compartment and visible surface cleaning']
      },
      'boat-detail': {
        name: 'Premium Boat Detail',
        description: 'Our most complete marine service for restoring and protecting your boat.',
        includes: ['Complete interior cleaning', 'Complete exterior cleaning', 'Hull polishing and gloss restoration', 'Surface protectant application', 'Detail cleaning and professional finish']
      },
      'jetski-premium': {
        name: 'Premium Jet Ski Wash',
        description: 'Complete jet ski and trailer wash with thorough salt removal.',
        includes: ['Complete jet ski and trailer wash', 'Freshwater rinse', 'Salt and sand removal', 'Hull and seat cleaning', 'Complete drying']
      },
      'jetski-membresia': {
        name: 'Membership (2x per month)',
        description: 'Biweekly maintenance to keep your personal watercraft ready for the water.',
        includes: ['2 premium wash visits per month', 'Trailer wash and freshwater rinse', 'Salt removal']
      },
      'golf-premium': {
        name: 'Premium Golf Cart Wash',
        description: 'Complete detailed wash including seats, steering wheel, roof, and wheels.',
        includes: ['Complete exterior wash and roof cleaning', 'Seat, steering wheel, and dashboard cleaning', 'Wheel and rim cleaning', 'Interior cleaning and detailed drying']
      },
      'golf-membresia': {
        name: 'Membership (2x per month)',
        description: 'Recurring monthly maintenance with two golf cart visits per month.',
        includes: ['2 premium wash visits per month', 'Seat, dashboard, wheel, and steering wheel cleaning', 'Detailed drying']
      },
      'atv-premium': {
        name: 'Premium ATV Wash',
        description: 'Pressure washing for mud, sand, dust, and grease with detailed cleaning of visible mechanical areas.',
        includes: ['Pressure washing', 'Mud, sand, and dust removal', 'Visible suspension cleaning', 'Wheel and rim cleaning', 'Seat and fender cleaning', 'Light and handlebar cleaning', 'Detailed drying']
      },
      'atv-membresia': {
        name: 'Membership (2x per month)',
        description: 'Two monthly visits to keep your ATV clean after every ride.',
        includes: ['2 detailed pressure wash visits per month', 'Suspension, fender, and plastic trim cleaning']
      },
      'mobile-home-basico': {
        name: 'Basic Premium Wash',
        description: 'Professional exterior soft-wash for mobile homes. Removes mold, algae, and dirt.',
        includes: ['Complete exterior wash', 'Soft-wash or low-pressure technique based on surface material', 'Mold, algae, and mildew removal', 'Built-up dirt and cobweb removal', 'Complete rinse and final quality inspection']
      },
      'driveway-basico': {
        name: 'Basic Pressure Wash',
        description: 'Efficient cleaning for concrete, paved surfaces, driveways, and patios.',
        includes: ['Professional pressure washing', 'Dirt, mold, and algae removal', 'Dust removal and complete rinse', 'Final quality inspection']
      },
      'driveway-premium': {
        name: 'Premium Pressure Wash',
        description: 'Recommended for concrete with tough stains, oil spots, and automotive fluids.',
        includes: ['Everything in the Basic Pressure Wash', 'Professional degreaser application', 'Specialized oil stain treatment', 'Surface paint and automotive fluid removal', 'Specialized surface restoration products']
      }
    };

    SERVICE_COPY_EN = { categories: categoryCopy, packages: packageCopy };
    SERVICE_COPY_ES = snapshotServiceCopy();
    // Category display names were authored in English in SERVICES_DATA; provide
    // Spanish equivalents so category cards match the translated route cards.
    const catNamesEs = {
      cars: 'Autos y SUVs',
      paint_correction: 'Corrección y Protección de Pintura',
      heavy_trucks: 'Camiones Pesados',
      boats: 'Botes y Embarcaciones',
      jetski: 'Jet Ski',
      golf_cart: 'Carrito de Golf',
      atv: 'ATVs y Cuatrimotos',
      mobile_home: 'Casas Móviles',
      driveway: 'Entradas y Patios'
    };
    Object.keys(catNamesEs).forEach(id => {
      if (SERVICE_COPY_ES.categories[id]) SERVICE_COPY_ES.categories[id].name = catNamesEs[id];
    });
  }

  // Snapshot the Spanish strings currently in SERVICES_DATA into the same shape
  // as the English maps. Must run BEFORE any language is applied.
  function snapshotServiceCopy() {
    const categories = {}, packages = {};
    SERVICES_DATA.categories.forEach(category => {
      const c = { name: category.name, sizes: {}, extras: {} };
      (category.sizes || []).forEach(s => { c.sizes[s.id] = s.name; });
      (category.extras || []).forEach(e => { c.extras[e.id] = [e.name, e.range]; });
      categories[category.id] = c;
      (category.packages || []).forEach(p => {
        packages[p.id] = { name: p.name, description: p.description, includes: p.includes.slice() };
      });
    });
    return { categories, packages };
  }

  // Swap the live SERVICES_DATA strings to the requested language.
  function applyServiceLanguage(lang) {
    const copy = (lang === 'es' ? SERVICE_COPY_ES : SERVICE_COPY_EN) || SERVICE_COPY_EN;
    if (!copy) return;
    SERVICES_DATA.categories.forEach(category => {
      const catCopy = copy.categories[category.id];
      if (catCopy && catCopy.name) category.name = catCopy.name;
      (category.sizes || []).forEach(size => {
        const label = catCopy && catCopy.sizes ? catCopy.sizes[size.id] : null;
        if (label) size.name = label;
      });
      (category.extras || []).forEach(extra => {
        const next = catCopy && catCopy.extras ? catCopy.extras[extra.id] : null;
        if (next) {
          if (next[0]) extra.name = next[0];
          extra.range = next[1];
        }
      });
      (category.packages || []).forEach(pkg => {
        const next = copy.packages[pkg.id];
        if (next) {
          if (next.name) pkg.name = next.name;
          if (next.description) pkg.description = next.description;
          if (next.includes) pkg.includes = next.includes;
        }
      });
    });
  }

  // Build the bilingual store, then apply the active language.
  setupBilingualServiceCopy();
  applyServiceLanguage(LANG);

  // ──────────────────────────────────────────────
  // ENRICHMENT — clusters, package types, groups,
  // recommender metadata (no real prices touched)
  // ──────────────────────────────────────────────
  const CATEGORY_CLUSTERS = {
    cars: 'vehicles',
    paint_correction: 'paint_protection',
    boats: 'marine',
    jetski: 'marine',
    golf_cart: 'recreation',
    atv: 'recreation',
    mobile_home: 'fleet_property',
    driveway: 'fleet_property',
    heavy_trucks: 'fleet_property'
  };

  const CLUSTER_FILTERS = [
    { id: 'all', label: 'All' },
    { id: 'vehicles', label: 'Vehicle Detailing' },
    { id: 'paint_protection', label: 'Paint Protection' },
    { id: 'marine', label: 'Marine' },
    { id: 'recreation', label: 'Recreation' },
    { id: 'fleet_property', label: 'Fleet & Property' }
  ];

  const CATEGORY_ORDER = [
    'cars',
    'paint_correction',
    'boats',
    'jetski',
    'golf_cart',
    'atv',
    'heavy_trucks',
    'mobile_home',
    'driveway'
  ];

  const SERVICE_ROUTES = {
    vehicles: { filter: 'vehicles' },
    paint_protection: { filter: 'paint_protection' },
    marine: { filter: 'marine' },
    recreation: { filter: 'recreation' },
    fleet_property: { filter: 'fleet_property' }
  };

  const CATEGORY_IMAGES = {
    cars: 'assets/service-cars.webp',
    paint_correction: 'assets/service-paint-correction.webp',
    heavy_trucks: 'assets/service-heavy-trucks.webp',
    boats: 'assets/service-boats.webp',
    jetski: 'assets/service-jetski.webp',
    golf_cart: 'assets/service-golf-cart.webp',
    atv: 'assets/service-atv.webp',
    mobile_home: 'assets/service-mobile-home.webp',
    driveway: 'assets/service-driveway.webp'
  };

  const PACKAGE_IMAGE_DIR = 'assets/packages/';

  const EXTRA_IMAGES = {
    'limpieza-motor': 'assets/extras/limpieza-motor.jpg',
    'engine-bay': 'assets/extras/engine-bay.jpg',
    'cera-rapida': 'assets/extras/cera-rapida.jpg',
    'sellador-pintura': 'assets/extras/sellador-pintura.jpg',
    'descontaminacion-pintura': 'assets/extras/descontaminacion-pintura.jpg',
    'tar-sap': 'assets/extras/tar-sap.jpg',
    'water-spots': 'assets/extras/water-spots.jpg',
    'repelente-cristales': 'assets/extras/repelente-cristales.jpg',
    'pelos-animal': 'assets/extras/pelos-animal.jpg',
    'eliminar-olores': 'assets/extras/eliminar-olores.jpg',
    'tratamiento-ozono': 'assets/extras/tratamiento-ozono.jpg',
    'limpieza-asientos': 'assets/extras/limpieza-asientos.jpg',
    'limpieza-alfombras': 'assets/extras/limpieza-alfombras.jpg',
    'limpieza-asiento': 'assets/extras/limpieza-asiento.jpg',
    'restauracion-plasticos': 'assets/extras/restauracion-plasticos.jpg',
    'pulido-faros': 'assets/extras/pulido-faros.jpg',
    'faros-recup': 'assets/extras/faros-recup.jpg',
    'ext-plastics': 'assets/extras/ext-plastics.jpg',
    'cargo-bed': 'assets/extras/cargo-bed.jpg',
    'limpieza-cabina': 'assets/extras/limpieza-cabina.jpg',
    'desengrasado-profundo': 'assets/extras/desengrasado-profundo.jpg',
    'motor-pesado': 'assets/extras/motor-pesado.jpg',
    'volteo-aluminio': 'assets/extras/volteo-aluminio.jpg',
    'rines-aluminio': 'assets/extras/rines-aluminio.jpg',
    'pulido-rines-llantas': 'assets/extras/pulido-rines-llantas.jpg',
    'car-hauler-second-deck': 'assets/extras/car-hauler-second-deck.jpg',
    'lubricante-grafito': 'assets/extras/lubricante-grafito.jpg',
    'pulido-tanques': 'assets/extras/pulido-tanques.jpg',
    'eliminacion-sal': 'assets/extras/eliminacion-sal.jpg',
    'brillo-plasticos': 'assets/extras/brillo-plasticos.jpg',
    'ceramica-marina': 'assets/extras/ceramica-marina.jpg',
    'engrasado-camion': 'assets/extras/engrasado-camion.jpg',
    'limpieza-chasis': 'assets/extras/limpieza-chasis.jpg',
    'boat-motor': 'assets/extras/boat-motor.jpg',
    'boat-vinilo-uv': 'assets/extras/boat-vinilo-uv.jpg',
    'boat-cera-marina': 'assets/extras/boat-cera-marina.jpg',
    'boat-pulido': 'assets/extras/boat-pulido.jpg',
    'boat-oxidacion': 'assets/extras/boat-oxidacion.jpg',
    'boat-ceramica': 'assets/extras/boat-ceramica.jpg',
    'boat-inox': 'assets/extras/boat-inox.jpg',
    'boat-compartimientos': 'assets/extras/boat-compartimientos.jpg',
    'boat-manchas-agua': 'assets/extras/boat-manchas-agua.jpg',
    'boat-marcas-casco': 'assets/extras/boat-marcas-casco.jpg',
    'boat-lona-bimini': 'assets/extras/boat-lona-bimini.jpg',
    'boat-repelente-cristales': 'assets/extras/boat-repelente-cristales.jpg',
    'boat-olores-ozono': 'assets/extras/boat-olores-ozono.jpg',
    'boat-teca': 'assets/extras/boat-teca.jpg'
  };

  const HEAVY_GROUPS = [
    { id: 'box-truck', label: { en: 'Box Truck', es: 'Camión de Caja' } },
    { id: 'semi-truck', label: { en: 'Semi Truck', es: 'Tractocamión' } },
    { id: 'trailer', label: { en: 'Trailers', es: 'Tráilers' } },
    { id: 'dump-truck', label: { en: 'Dump Truck', es: 'Camión de Volteo' } },
    { id: 'garbage-truck', label: { en: 'Garbage Truck', es: 'Camión de Basura' } }
  ];
  // Packages whose id prefix doesn't match their HEAVY_GROUPS group:
  // car haulers are a type of trailer, so they live under the "trailer" chip.
  const PACKAGE_GROUP_OVERRIDES = { 'car-hauler': 'trailer' };

  // Per-category recommender config — references add-on ids that already exist
  const RECO = {
    cars: {
      recommended: ['sellador-pintura', 'limpieza-asientos', 'tratamiento-ozono'],
      popular: ['cera-rapida', 'limpieza-motor'],
      bundles: [
        { id: 'pet-owner', name: { en: 'Pet Owner Pack', es: 'Pack para Mascotas' }, desc: { en: 'Hair, odors & sanitizing for pet parents.', es: 'Pelos, olores y sanitizado para dueños de mascotas.' }, addons: ['pelos-animal', 'eliminar-olores', 'tratamiento-ozono'] },
        { id: 'showroom', name: { en: 'Showroom Shine', es: 'Brillo de Exhibición' }, desc: { en: 'Decontaminate, seal & gloss like new.', es: 'Descontamina, sella y abrillanta como nuevo.' }, addons: ['descontaminacion-pintura', 'sellador-pintura', 'cera-rapida', 'restauracion-plasticos'] },
        { id: 'fresh-cabin', name: { en: 'Fresh Cabin', es: 'Cabina Fresca' }, desc: { en: 'A spotless, fresh-smelling interior.', es: 'Un interior impecable y con aroma fresco.' }, addons: ['limpieza-asientos', 'limpieza-alfombras', 'eliminar-olores'] }
      ],
      quiz: [
        { id: 'pets', q: { en: 'Pets ride with you?', es: '¿Viajan mascotas contigo?' }, addons: ['pelos-animal'] },
        { id: 'odors', q: { en: 'Lingering odors or smoke?', es: '¿Olores persistentes o humo?' }, addons: ['eliminar-olores', 'tratamiento-ozono'] },
        { id: 'overdue', q: { en: 'Been 6+ months since a deep detail?', es: '¿Más de 6 meses sin un detallado profundo?' }, addons: ['descontaminacion-pintura', 'sellador-pintura'] },
        { id: 'shine', q: { en: 'Want long-lasting shine & protection?', es: '¿Quieres brillo y protección duraderos?' }, addons: ['cera-rapida', 'restauracion-plasticos'] },
        { id: 'headlights', q: { en: 'Foggy or yellow headlights?', es: '¿Faros opacos o amarillentos?' }, addons: ['pulido-faros'] }
      ]
    },
    paint_correction: {
      recommended: ['ext-plastics', 'repelente-cristales'],
      popular: ['engine-bay'],
      bundles: [
        { id: 'prep-protect', name: { en: 'Prep & Protect', es: 'Preparar y Proteger' }, desc: { en: 'Strip contaminants, shield trim & glass.', es: 'Elimina contaminantes y protege plásticos y cristales.' }, addons: ['tar-sap', 'ext-plastics', 'repelente-cristales'] }
      ],
      quiz: [
        { id: 'tar', q: { en: 'Tar, sap or overspray on the paint?', es: '¿Alquitrán, savia o sobrespray en la pintura?' }, addons: ['tar-sap'] },
        { id: 'spots', q: { en: 'Hard water spots?', es: '¿Manchas de agua dura?' }, addons: ['water-spots'] },
        { id: 'headlights', q: { en: 'Yellow or foggy headlights?', es: '¿Faros amarillentos u opacos?' }, addons: ['faros-recup'] },
        { id: 'engine', q: { en: 'Want the engine bay detailed?', es: '¿Quieres detallar el compartimiento del motor?' }, addons: ['engine-bay'] }
      ]
    },
    heavy_trucks: {
      recommended: ['limpieza-cabina', 'rines-aluminio'],
      popular: ['desengrasado-profundo'],
      bundles: [
        { id: 'heavy-degrease', name: { en: 'Heavy-Duty Degrease', es: 'Desengrase Pesado' }, desc: { en: 'Cut grease on engine, chassis & wheels.', es: 'Elimina grasa en motor, chasis y rines.' }, addons: ['desengrasado-profundo', 'motor-pesado', 'rines-aluminio'] }
      ],
      quiz: [
        { id: 'cab', q: { en: 'Cab interior needs cleaning?', es: '¿La cabina necesita limpieza interior?' }, addons: ['limpieza-cabina'] },
        { id: 'grease', q: { en: 'Heavy grease on engine or chassis?', es: '¿Grasa pesada en motor o chasis?' }, addons: ['desengrasado-profundo', 'motor-pesado'] },
        { id: 'aluminum', q: { en: 'Aluminum wheels or tanks to shine?', es: '¿Rines o tanques de aluminio para pulir?' }, addons: ['rines-aluminio', 'pulido-tanques'] }
      ]
    },
    jetski: {
      recommended: ['eliminacion-sal', 'ceramica-marina'],
      popular: ['brillo-plasticos'],
      bundles: [
        { id: 'marine-protect', name: { en: 'Marine Protect', es: 'Protección Marina' }, desc: { en: 'Beat salt & lock in a marine-grade shine.', es: 'Combate la sal y sella un brillo de nivel marino.' }, addons: ['eliminacion-sal', 'ceramica-marina', 'brillo-plasticos'] }
      ],
      quiz: [
        { id: 'salt', q: { en: 'Used in salt water?', es: '¿Lo usas en agua salada?' }, addons: ['eliminacion-sal', 'ceramica-marina'] },
        { id: 'plastics', q: { en: 'Faded plastics?', es: '¿Plásticos descoloridos?' }, addons: ['brillo-plasticos'] },
        { id: 'seat', q: { en: 'Seat needs deep cleaning?', es: '¿El asiento necesita limpieza profunda?' }, addons: ['limpieza-asiento'] }
      ]
    }
  };

  const FROM_PRICE_EXTRA_IDS = new Set(['motor-pesado', 'rines-aluminio', 'boat-cera-marina', 'boat-pulido']);

  // ──────────────────────────────────────────────
  // UI STRING DICTIONARY (everything outside SERVICES_DATA / RECO)
  // ──────────────────────────────────────────────
  const UI_STRINGS = {
    // Nav
    'nav.paths': { en: 'Service Paths', es: 'Rutas de Servicio' },
    'nav.quote': { en: 'Quote', es: 'Cotizar' },
    'nav.policies': { en: 'Policies', es: 'Políticas' },
    'nav.cta': { en: 'Build My Quote', es: 'Arma tu Cotización' },
    // Hero
    'hero.kicker': { en: 'Premium Mobile Detailing · SWFL', es: 'Detailing Móvil Premium · SWFL' },
    'hero.titleA': { en: 'Mobile detailing that ', es: 'Detailing móvil que ' },
    'hero.titleB': { en: 'comes to you.', es: 'llega a ti.' },
    'hero.ctaQuote': { en: 'Build My Quote', es: 'Arma tu Cotización' },
    'hero.ctaCall': { en: 'Call Now', es: 'Llamar Ahora' },
    'hero.scroll': { en: 'Scroll', es: 'Desliza' },
    // Service paths
    'paths.label': { en: 'Choose Your Path', es: 'Elige tu Ruta' },
    'paths.titleA': { en: 'One mobile team. ', es: 'Un solo equipo móvil. ' },
    'paths.titleB': { en: 'Clear service paths.', es: 'Rutas de servicio claras.' },
    'paths.subtitle': { en: 'Start with the path that matches what you need today, then build a precise quote in the service builder.', es: 'Comienza con la ruta que coincide con lo que necesitas hoy y arma una cotización precisa en el configurador.' },
    'path.a.kicker': { en: 'Path A', es: 'Ruta A' },
    'path.a.title': { en: 'Vehicle Detailing', es: 'Detailing de Vehículos' },
    'path.a.desc': { en: 'Maintenance washes, deep interior care, and paint-safe detailing for daily drivers, SUVs, trucks, and vans.', es: 'Lavados de mantenimiento, cuidado profundo de interiores y detailing seguro para la pintura de autos, SUVs, camionetas y vans.' },
    'path.a.cta': { en: 'Start Vehicle Quote', es: 'Cotizar Vehículo' },
    'path.b.kicker': { en: 'Path B', es: 'Ruta B' },
    'path.b.title': { en: 'Paint Protection', es: 'Protección de Pintura' },
    'path.b.desc': { en: 'Gloss enhancement, paint correction, sealants, ceramic protection, and surface prep for a deeper finish.', es: 'Realce de brillo, corrección de pintura, selladores, protección cerámica y preparación de superficie para un acabado superior.' },
    'path.b.cta': { en: 'Start Paint Quote', es: 'Cotizar Pintura' },
    'path.c.kicker': { en: 'Path C', es: 'Ruta C' },
    'path.c.title': { en: 'Marine', es: 'Náutica' },
    'path.c.desc': { en: 'Boat and jet ski washing, salt removal, marine-safe surface care, and cleanups after Southwest Florida water days.', es: 'Lavado de botes y jet skis, remoción de sal, cuidado seguro para superficies marinas y limpieza después de tus días en el agua.' },
    'path.c.cta': { en: 'Start Marine Quote', es: 'Cotizar Náutica' },
    'path.d.kicker': { en: 'Path D', es: 'Ruta D' },
    'path.d.title': { en: 'Recreation', es: 'Recreación' },
    'path.d.desc': { en: 'Golf cart and ATV cleaning for communities, weekend toys, trails, mud, dust, and outdoor storage buildup.', es: 'Limpieza de carritos de golf y ATVs para comunidades, vehículos de fin de semana, senderos, barro, polvo y acumulación por almacenamiento.' },
    'path.d.cta': { en: 'Start Recreation Quote', es: 'Cotizar Recreación' },
    'path.e.kicker': { en: 'Path E', es: 'Ruta E' },
    'path.e.title': { en: 'Fleet & Property', es: 'Flotas y Propiedades' },
    'path.e.desc': { en: 'Commercial trucks, recurring fleet care, mobile home soft washing, driveways, patios, and pressure washing.', es: 'Camiones comerciales, cuidado recurrente de flotas, soft wash de casas móviles, entradas, patios y lavado a presión.' },
    'path.e.cta': { en: 'Start Fleet Quote', es: 'Cotizar Flota' },
    'chip.cars': { en: 'Cars & SUVs', es: 'Autos y SUVs' },
    'chip.correction': { en: 'Correction', es: 'Corrección' },
    'chip.boats': { en: 'Boats', es: 'Botes' },
    'chip.jetski': { en: 'Jet Ski', es: 'Jet Ski' },
    'chip.golf': { en: 'Golf Cart', es: 'Carrito de Golf' },
    'chip.atv': { en: 'ATV', es: 'ATV' },
    'chip.heavy': { en: 'Heavy Trucks', es: 'Camiones Pesados' },
    'chip.mobilehome': { en: 'Mobile Homes', es: 'Casas Móviles' },
    'chip.driveway': { en: 'Driveways', es: 'Entradas' },
    // Quoter header + stepper
    'quoter.label': { en: 'Build Your Service', es: 'Arma tu Servicio' },
    'quoter.titleA': { en: 'Build Your ', es: 'Arma tu ' },
    'quoter.titleB': { en: 'Quote', es: 'Cotización' },
    'quoter.subtitle': { en: 'Choose a path, build your service, and reserve a live opening on our calendar.', es: 'Elige una ruta, arma tu servicio y reserva una disponibilidad real en nuestro calendario.' },
    'quoter.proof1': { en: '1. Pick a path', es: '1. Elige una ruta' },
    'quoter.proof2': { en: '2. See your estimate', es: '2. Mira tu estimado' },
    'quoter.proof3': { en: '3. Confirm your appointment', es: '3. Confirma tu cita' },
    'step.service': { en: 'Service', es: 'Servicio' },
    'step.package': { en: 'Package', es: 'Paquete' },
    'step.extras': { en: 'Extras', es: 'Extras' },
    'step.schedule': { en: 'Schedule', es: 'Agenda' },
    'step.book': { en: 'Book', es: 'Reservar' },
    'qbar.label': { en: 'Live estimate', es: 'Estimado en vivo' },
    'filter.all': { en: 'All', es: 'Todos' },
    'filter.vehicles': { en: 'Vehicle Detailing', es: 'Detailing de Vehículos' },
    'filter.paint_protection': { en: 'Paint Protection', es: 'Protección de Pintura' },
    'filter.marine': { en: 'Marine', es: 'Náutica' },
    'filter.recreation': { en: 'Recreation', es: 'Recreación' },
    'filter.fleet_property': { en: 'Fleet & Property', es: 'Flotas y Propiedades' },
    // Wizard step titles
    'ws.chooseService': { en: 'Choose a Service', es: 'Elige un Servicio' },
    'ws.selectOption': { en: 'Select Your Option', es: 'Selecciona tu Opción' },
    'ws.selectSize': { en: 'Select Size / Quantity', es: 'Selecciona Tamaño / Cantidad' },
    'ws.addExtras': { en: 'Add Extras', es: 'Agrega Extras' },
    'ws.extrasNote': { en: "Extras are optional — skip if you don't need any.", es: 'Los extras son opcionales — omítelos si no los necesitas.' },
    'ws.scheduleTitle': { en: 'Schedule & Details', es: 'Agenda y Detalles' },
    'ws.scheduleIntro': { en: "Choose a live opening from our mobile team's calendar.", es: 'Elige una disponibilidad real del calendario de nuestro equipo móvil.' },
    'ws.reviewTitle': { en: 'Review & Book', es: 'Revisa y Reserva' },
    // Schedule form
    'form.contactDetails': { en: 'Contact details', es: 'Datos de contacto' },
    'form.vehicleDetails': { en: 'Vehicle details', es: 'Datos del vehículo' },
    'form.serviceDetails': { en: 'Service location and time', es: 'Lugar y horario del servicio' },
    'form.name': { en: 'Full name', es: 'Nombre completo' },
    'form.namePh': { en: 'Your name', es: 'Tu nombre' },
    'form.phone': { en: 'Phone', es: 'Teléfono' },
    'form.email': { en: 'Email', es: 'Email' },
    'form.emailPh': { en: 'you@example.com', es: 'tu@email.com' },
    'form.vehicleMake': { en: 'Make', es: 'Marca' },
    'form.vehicleMakePh': { en: 'e.g. Toyota', es: 'ej. Toyota' },
    'form.vehicleModel': { en: 'Model', es: 'Modelo' },
    'form.vehicleModelPh': { en: 'e.g. Camry', es: 'ej. Camry' },
    'form.vehicleYear': { en: 'Year', es: 'Año' },
    'form.vehicleYearPh': { en: 'e.g. 2024', es: 'ej. 2024' },
    'form.vehicleColor': { en: 'Color', es: 'Color' },
    'form.vehicleColorPh': { en: 'e.g. Electric blue', es: 'ej. Azul eléctrico' },
    'form.vehiclePlate': { en: 'License plate', es: 'Matrícula' },
    'form.vehiclePlatePh': { en: 'e.g. ABC 123', es: 'ej. ABC 123' },
    'form.zip': { en: 'Service area / ZIP', es: 'Zona / Código Postal' },
    'form.zipPh': { en: 'e.g. 33901', es: 'ej. 33901' },
    'form.address': { en: 'Street address', es: 'Dirección (calle y número)' },
    'form.addressPh': { en: 'e.g. 1234 Palm Ave', es: 'ej. 1234 Palm Ave' },
    'form.unit': { en: 'Apt / Unit', es: 'Apto / Unidad' },
    'form.unitPh': { en: 'e.g. Apt 2B', es: 'ej. Apto 2B' },
    'form.city': { en: 'City', es: 'Ciudad' },
    'form.cityPh': { en: 'e.g. Fort Myers', es: 'ej. Fort Myers' },
    'form.date': { en: 'Available date', es: 'Fecha disponible' },
    'form.dateHint': { en: 'Please book at least 1 hour ahead.', es: 'Reserva con al menos 1 hora de anticipación.' },
    'form.dateHintMembership': { en: 'Membership visits must be booked at least 48 hours ahead.', es: 'Las visitas de membresía deben reservarse con al menos 48 horas de anticipación.' },
    'form.time': { en: 'Start time', es: 'Hora de inicio' },
    'tw.full_day': { en: 'Full day (8am–6pm)', es: 'Día completo (8am–6pm)' },
    'form.duration': { en: 'Estimated on site: {duration}', es: 'Tiempo estimado en sitio: {duration}' },
    'availability.loading': { en: 'Loading availability…', es: 'Cargando disponibilidad…' },
    'availability.chooseDate': { en: 'Choose an available date', es: 'Elige una fecha disponible' },
    'availability.ready': { en: 'Live availability loaded from our calendar.', es: 'Disponibilidad actualizada desde nuestro calendario.' },
    'availability.empty': { en: 'No online openings are available in the next 60 days. Contact us for help.', es: 'No hay turnos online disponibles en los próximos 60 días. Contáctanos para ayudarte.' },
    'availability.error': { en: 'We could not load the calendar. Please retry in a moment.', es: 'No pudimos cargar el calendario. Intenta nuevamente en un momento.' },
    'availability.fullDay': { en: 'This service reserves the complete day, from 8am to 6pm.', es: 'Este servicio reserva el día completo, de 8am a 6pm.' },
    'deposit.label': { en: 'Deposit to confirm', es: 'Depósito para confirmar' },
    'deposit.hint': { en: 'A ${amount} deposit confirms this booking. We invoice it from our CRM; it is credited to your final total.', es: 'Un depósito de ${amount} confirma esta reserva. Lo facturamos desde nuestro CRM y se descuenta del total final.' },
    'form.notes': { en: 'Notes', es: 'Notas' },
    'form.notesOpt': { en: '(optional)', es: '(opcional)' },
    'form.notesPh': { en: 'Gate code, vehicle condition, special requests…', es: 'Código de portón, estado del vehículo, pedidos especiales…' },
    // Nav buttons
    'btn.startOver': { en: 'Start over', es: 'Empezar de nuevo' },
    'btn.back': { en: 'Back', es: 'Atrás' },
    'btn.next': { en: 'Next', es: 'Siguiente' },
    'btn.review': { en: 'Review', es: 'Revisar' },
    'btn.book': { en: 'Confirm booking', es: 'Confirmar reserva' },
    'btn.booked': { en: 'Booking confirmed', es: 'Reserva confirmada' },
    'btn.saving': { en: 'Confirming appointment…', es: 'Confirmando cita…' },
    'btn.retry': { en: 'Retry booking', es: 'Reintentar reserva' },
    'btn.continueWhatsApp': { en: 'Contact us on WhatsApp', es: 'Contactarnos por WhatsApp' },
    // Policies header
    'policies.label': { en: 'Important Information', es: 'Información Importante' },
    'policies.titleA': { en: 'Service ', es: 'Políticas de ' },
    'policies.titleB': { en: 'Policies', es: 'Servicio' },
    'policies.subtitle': { en: 'Clear operating terms designed to keep every appointment safe, on time, and held to a premium standard.', es: 'Términos operativos claros para que cada cita sea segura, puntual y con estándar premium.' },
    'pol.1.h': { en: 'Quality Guarantee and Claims', es: 'Garantía de Calidad y Reclamos' },
    'pol.2.h': { en: 'Property Access and Availability', es: 'Acceso a la Propiedad y Disponibilidad' },
    'pol.3.h': { en: 'Cancellation and No-Show Policy', es: 'Política de Cancelación y Ausencias' },
    'pol.4.h': { en: 'Payment and Billing Policy', es: 'Política de Pagos y Facturación' },
    'pol.5.h': { en: 'Monthly Membership Terms', es: 'Términos de la Membresía Mensual' },
    'pol.6.h': { en: 'Personal Items and Liability', es: 'Objetos Personales y Responsabilidad' },
    // Footer
    'footer.copy': { en: '© 2026 L&B Elite Wash & Detail. All rights reserved.', es: '© 2026 L&B Elite Wash & Detail. Todos los derechos reservados.' },
    // Dynamic wizard labels
    'from': { en: 'From', es: 'Desde' },
    'selected': { en: 'Selected', es: 'Seleccionado' },
    'choosePlan': { en: 'Choose plan', es: 'Elegir plan' },
    'mostPopular': { en: 'Most popular', es: 'Más popular' },
    'package.viewAll': { en: 'Show everything included', es: 'Ver todo lo que incluye' },
    'oneTime': { en: 'One-time', es: 'Único' },
    'membership': { en: 'Membership', es: 'Membresía' },
    'recommendExtras': { en: 'Recommend my extras', es: 'Recomiéndame extras' },
    'recoHint': { en: "Answer a few quick questions — we'll suggest the ideal add-ons.", es: 'Responde unas preguntas rápidas — te sugerimos los extras ideales.' },
    'bundleAdd': { en: '+ Add bundle', es: '+ Agregar combo' },
    'bundleRemove': { en: '✓ Added — tap to remove', es: '✓ Agregado — toca para quitar' },
    'quizTitle': { en: 'Tap everything that applies to you:', es: 'Toca todo lo que aplique a tu caso:' },
    'quizApply': { en: 'Apply suggestions', es: 'Aplicar sugerencias' },
    'quizClear': { en: 'Clear', es: 'Limpiar' },
    'badgeRecYou': { en: 'Recommended for you', es: 'Recomendado para ti' },
    'badgeRec': { en: 'Recommended', es: 'Recomendado' },
    'badgeChosen': { en: 'Most chosen', es: 'Más elegido' },
    'emptyStep3': { en: 'No extra configuration or add-ons are required for this service.', es: 'Este servicio no requiere configuración adicional ni extras.' },
    'standard': { en: 'Standard', es: 'Estándar' },
    'sum.category': { en: 'Category', es: 'Categoría' },
    'sum.service': { en: 'Service', es: 'Servicio' },
    'sum.size': { en: 'Size / Option', es: 'Tamaño / Opción' },
    'sum.addons': { en: 'Add-ons', es: 'Extras' },
    'sum.name': { en: 'Name', es: 'Nombre' },
    'sum.email': { en: 'Email', es: 'Email' },
    'sum.vehicle': { en: 'Vehicle', es: 'Vehículo' },
    'sum.plate': { en: 'License plate', es: 'Matrícula' },
    'sum.address': { en: 'Address', es: 'Dirección' },
    'sum.area': { en: 'Service area', es: 'Zona de servicio' },
    'sum.time': { en: 'Confirmed time', es: 'Horario confirmado' },
    'sum.notes': { en: 'Notes', es: 'Notas' },
    'sum.total': { en: 'Estimated Total', es: 'Total Estimado' },
    'sum.disclaimer': { en: '*Reference estimate. Final pricing may vary based on the real condition of the vehicle or surface.', es: '*Estimado de referencia. El precio final puede variar según el estado real del vehículo o la superficie.' },
    'sum.included': { en: 'Included Services:', es: 'Servicios Incluidos:' },
    'sum.empty': { en: 'Complete the previous steps to see your estimate.', es: 'Completa los pasos anteriores para ver tu estimado.' },
    'cov.enterZip': { en: 'Enter a 5-digit ZIP code.', es: 'Ingresa un código postal de 5 dígitos.' },
    'cov.inRange': { en: 'In range — within our Southwest Florida service area.', es: 'En cobertura — dentro de nuestra zona del Suroeste de Florida.' },
    'cov.confirm': { en: "We'll confirm coverage for this ZIP when we reach out.", es: 'Confirmaremos la cobertura de este código postal al contactarte.' },
    'cov.accepted': { en: 'Service address recorded for this appointment.', es: 'Dirección de servicio registrada para esta cita.' },
    'qbar.build': { en: 'Build your service to see a live estimate', es: 'Arma tu servicio para ver un estimado en vivo' },
    'cart.title': { en: 'Services in this visit', es: 'Servicios en esta visita' },
    'cart.hint': { en: 'One visit — same address, date and time for every vehicle.', es: 'Una sola visita — misma dirección, fecha y horario para todos los vehículos.' },
    'cart.edit': { en: 'Edit', es: 'Editar' },
    'cart.remove': { en: 'Remove', es: 'Quitar' },
    'cart.count': { en: '{n} services in this visit', es: '{n} servicios en esta visita' },
    'cart.max': { en: 'You\'ve reached the limit of services per booking — contact us for larger fleets.', es: 'Llegaste al límite de servicios por reserva — contáctanos para flotas más grandes.' },
    'btn.addAnother': { en: 'Add another vehicle', es: 'Agregar otro vehículo' },
    'form.vehicleN': { en: 'Vehicle {n}', es: 'Vehículo {n}' },
    'wa.serviceN': { en: 'Service {n}', es: 'Servicio {n}' },
    'availability.cartChanged': { en: 'Your services changed — please pick a date again.', es: 'Cambiaron los servicios de la visita — vuelve a elegir la fecha.' },
    'customQuote': { en: '+ Custom Quote', es: '+ Cotización personalizada' },
    // WhatsApp message
    'wa.title': { en: 'New Booking — L&B Elite Wash & Detail', es: 'Nueva Reserva — L&B Elite Wash & Detail' },
    'wa.category': { en: 'Category', es: 'Categoría' },
    'wa.service': { en: 'Service', es: 'Servicio' },
    'wa.size': { en: 'Size/Option', es: 'Tamaño/Opción' },
    'wa.addons': { en: 'Add-ons', es: 'Extras' },
    'wa.total': { en: 'Estimated Total', es: 'Total Estimado' },
    'wa.contact': { en: 'Contact', es: 'Contacto' },
    'wa.phone': { en: 'Phone', es: 'Teléfono' },
    'wa.email': { en: 'Email', es: 'Email' },
    'wa.vehicle': { en: 'Vehicle', es: 'Vehículo' },
    'wa.plate': { en: 'License plate', es: 'Matrícula' },
    'wa.address': { en: 'Address', es: 'Dirección' },
    'wa.city': { en: 'City', es: 'Ciudad' },
    'wa.area': { en: 'Service area / ZIP', es: 'Zona / Código Postal' },
    'wa.date': { en: 'Confirmed date', es: 'Fecha confirmada' },
    'wa.time': { en: 'Confirmed time', es: 'Horario confirmado' },
    'wa.notes': { en: 'Notes', es: 'Notas' },
    'wa.closing': { en: 'My appointment is confirmed. I have a question about this booking.', es: 'Mi cita está confirmada. Tengo una consulta sobre esta reserva.' },
    'submit.saving': { en: 'Confirming your appointment securely…', es: 'Confirmando tu cita de forma segura…' },
    'submit.success': { en: 'Appointment confirmed. Reservation number:', es: 'Cita confirmada. Número de reserva:' },
    'submit.slotTaken': { en: 'That opening was just booked. Choose another available time; all your information is still here.', es: 'Ese turno acaba de ocuparse. Elige otro horario disponible; todos tus datos siguen aquí.' },
    'submit.error': { en: "We couldn't create the appointment. No booking was confirmed; your information is still here so you can retry or contact us.", es: 'No pudimos crear la cita. No hay una reserva confirmada; tus datos siguen aquí para reintentar o contactarnos.' },
    'submit.depositCta': { en: 'Pay your ${amount} deposit', es: 'Pagar depósito de ${amount}' },
    'submit.depositHint': { en: 'Lock in your booking now — this deposit is credited to your final total.', es: 'Asegura tu reserva ahora — este depósito se descuenta del total final.' },
    'wa.quick': { en: "Hi L&B Elite! I'd like to book a service.", es: 'Hola L&B Elite, me gustaría reservar un servicio.' },
    'waFloat.aria': { en: 'Contact us on WhatsApp', es: 'Contactar por WhatsApp' }
  };

  // Apply the active language to all static [data-i18n*] nodes.
  function applyUILanguage() {
    document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.getAttribute('data-i18n')); });
    document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph'))); });
    document.querySelectorAll('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria'))); });
  }

  function enrichServicesData() {
    SERVICES_DATA.categories.forEach(cat => {
      cat.cluster = CATEGORY_CLUSTERS[cat.id] || 'vehicles';
      if (CATEGORY_IMAGES[cat.id]) cat.image = CATEGORY_IMAGES[cat.id];
      if (cat.id === 'paint_correction') cat.compareView = true;
      if (cat.id === 'heavy_trucks') cat.groupBy = true;

      (cat.extras || []).forEach(extra => normalizeAddonPricing(extra));

      cat.packages.forEach(pkg => {
        normalizePackagePricing(pkg);
        pkg.type = /membresia|membership|-2x$|-4x$/.test(pkg.id) ? 'membership' : 'onetime';
        if (cat.id === 'heavy_trucks') {
          const overridePrefix = Object.keys(PACKAGE_GROUP_OVERRIDES).find(prefix => pkg.id.startsWith(prefix));
          const g = overridePrefix ? null : HEAVY_GROUPS.find(grp => pkg.id.startsWith(grp.id));
          pkg.group = overridePrefix ? PACKAGE_GROUP_OVERRIDES[overridePrefix] : (g ? g.id : 'other');
        }
      });

      const reco = RECO[cat.id] || {};
      cat.recommended = reco.recommended || [];
      cat.popular = reco.popular || [];
      cat.bundles = reco.bundles || [];
      cat.quiz = reco.quiz || [];
    });
  }
  enrichServicesData();

  // ──────────────────────────────────────────────
  // SHARED HELPERS
  // ──────────────────────────────────────────────
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" width="14" height="14" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>';
  const fmt = (n) => '$' + Math.round(n).toLocaleString('en-US');
  const escapeHTML = (value) => String(value == null ? '' : value).replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[char]);

  // Line-art vehicle silhouettes for the size/type selector (Step 3).
  // Stroke uses currentColor so they adopt the theme and glow on .selected.
  const SIZE_ICONS = {
    sedan: '<svg viewBox="0 0 50 30" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M3,18.5 L4,13.6 Q4.3,12.2 6.2,11.8 L10.5,11.2 L15.5,7.2 L27.5,7.2 L33,11.4 L43.5,12.4 Q45.8,12.6 46,14.8 L46,18.5 L41.5,18.5 Q35.5,13.4 29.5,18.5 L19,18.5 Q12.8,13.4 6.5,18.5 Z"/><circle cx="12.8" cy="21" r="3.5"/><circle cx="36" cy="21" r="3.5"/></svg>',
    suv: '<svg viewBox="0 0 50 30" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M3,18.5 L3.6,11 Q3.8,9.4 5.6,9 L8.6,8.6 L12.5,6 L33,6 L38.5,8.8 L45,9.8 Q46.6,10.1 46.6,11.8 L46.6,18.5 L41.5,18.5 Q35.5,13.2 29.5,18.5 L19,18.5 Q12.5,13.2 6.5,18.5 Z"/><circle cx="12.5" cy="21" r="3.6"/><circle cx="36.5" cy="21" r="3.6"/></svg>',
    truck: '<svg viewBox="0 0 50 30" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M3,18.5 L3.6,11.4 Q3.8,10 5.6,9.8 L8.8,9.5 L12.5,6.4 L20.5,6.4 L22.6,9.7 L22.6,12.8 L43.4,12.8 L43.4,10.8 L46.6,10.8 L46.6,18.5 L41.5,18.5 Q35.5,13.4 29.5,18.5 L19,18.5 Q12.5,13.4 6.5,18.5 Z"/><circle cx="12.5" cy="21" r="3.6"/><circle cx="36.5" cy="21" r="3.6"/></svg>',
    van: '<svg viewBox="0 0 50 30" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M2.8,18.5 L2.8,9.6 L6.8,6 L44.5,6 Q46.6,6 46.6,8.2 L46.6,18.5 L41.5,18.5 Q35.5,13.2 29.5,18.5 L19,18.5 Q12.5,13.2 6.5,18.5 Z"/><path d="M9.2,6.4 L9.2,11.2 L2.9,11.2"/><circle cx="12.5" cy="21" r="3.6"/><circle cx="37" cy="21" r="3.6"/></svg>',
    van_pequena: '<svg viewBox="0 0 50 30" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M3.5,18.5 L4,11 Q4.2,9 7,8.4 L13.5,7 Q18,6.2 24,6.4 L33,6.8 Q39,7.4 39.6,11 L39.6,18.5 L35.5,18.5 Q30,13.4 24.5,18.5 L17.5,18.5 Q12,13.4 6.5,18.5 Z"/><circle cx="11.8" cy="21" r="3.4"/><circle cx="33.2" cy="21" r="3.4"/></svg>',
    van_xl: '<svg viewBox="0 0 50 30" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M2,18.5 L2,8 L6,4.8 L46,4.8 Q48,4.8 48,7 L48,18.5 L43,18.5 Q39.5,13 34.5,18.5 L18,18.5 Q11.5,13 5.5,18.5 Z"/><path d="M9,5.2 L9,10 L2.1,10"/><circle cx="11" cy="21" r="3.6"/><circle cx="39.5" cy="21" r="3.6"/></svg>',
    box_truck: '<svg viewBox="0 0 50 30" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M2,18.5 L2,12.5 L4.5,10 L13,10 L13,4 L47,4 L47,18.5 L42.5,18.5 Q37.5,13.2 32.5,18.5 L16,18.5 Q10.5,13.2 5.5,18.5 Z"/><circle cx="10.5" cy="21" r="3.6"/><circle cx="39" cy="21" r="3.6"/></svg>',
    boat: '<svg viewBox="0 0 50 30" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M4,12.8 L44,9.8 Q47.5,9 47.5,11.5 L44,15 Q43,17.5 39,17.5 L10,17.5 Q4.5,17.5 4,12.8 Z"/><path d="M29,11.2 L31.5,7.8 L35.5,7.6 L36.5,10.6"/><path d="M3,20.4 q3,1.6 6,0 t6,0 t6,0 t6,0 t6,0 t6,0" stroke-width="1.6"/></svg>',
    jetski: '<svg viewBox="0 0 50 30" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M4,16.6 Q3.6,14.9 6.2,14.5 L25,13.4 Q30,10.8 35,11.2 L43.5,12.8 Q46.4,13.4 45.4,15.6 Q44.4,17.5 41,17.5 L9,17.5 Q4.6,17.5 4,16.6 Z"/><path d="M22.5,13.2 L21,9.6 L18.4,9.9"/><path d="M5,20.2 q3,1.5 6,0 t6,0 t6,0 t6,0 t6,0" stroke-width="1.6"/></svg>',
    atv: '<svg viewBox="0 0 50 30" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M5.5,16.5 Q5.5,12.8 9.8,12.4 L17,12 L20,8.6 L22.8,8.6 L23.9,11.8 L31.8,11.8 Q40.5,12.1 42.5,16.5"/><path d="M20.4,8.6 L18.8,6 L16.4,6.2"/><circle cx="11.5" cy="20.2" r="4.6"/><circle cx="37.5" cy="20.2" r="4.6"/><circle cx="11.5" cy="20.2" r="1.4"/><circle cx="37.5" cy="20.2" r="1.4"/></svg>',
    golf_cart: '<svg viewBox="0 0 50 30" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M6,17.5 L6,13 L9.5,13 L10.6,10.8 L29,10.8 L29,13 L37.5,13 L37.5,17.5"/><path d="M4,6.3 L40,6.3"/><path d="M6.6,11 L6.6,6.3"/><path d="M37,12.8 L37,6.3"/><path d="M20,12.8 L20,8.2"/><circle cx="11.5" cy="21.2" r="3"/><circle cx="33.5" cy="21.2" r="3"/></svg>',
    mobile_home: '<svg viewBox="0 0 44 30" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M2.5,11.5 L21,6.5 L39.5,11.5"/><path d="M5,11.5 L5,25 L37,25 L37,11.5"/><path d="M16,25 L16,16.5 L22.5,16.5 L22.5,25"/><path d="M26,14.5 L31.5,14.5 L31.5,18.5 L26,18.5 Z"/></svg>'
  };

  // Map a category + size id to an icon key and a repeat count (quantity / sections).
  function sizeIconInfo(catId, sizeId) {
    if (SIZE_ICONS[sizeId]) return { key: sizeId, count: 1 };
    const qty = /^qty_(\d)/.exec(sizeId);
    if (catId === 'jetski') return { key: 'jetski', count: qty ? +qty[1] : 1 };
    if (catId === 'atv') return { key: 'atv', count: qty ? +qty[1] : 1 };
    if (catId === 'mobile_home') return { key: 'mobile_home', count: sizeId === 'triple_wide' ? 3 : sizeId === 'double_wide' ? 2 : 1 };
    if (catId === 'heavy_trucks') return { key: 'box_truck', count: 1 };
    if (catId === 'boats') return { key: 'boat', count: 1 };
    if (catId === 'golf_cart') return { key: 'golf_cart', count: 1 };
    return null;
  }

  // Build the plaque markup for a size card (empty string when there is no icon).
  function sizeIconHTML(catId, sizeId) {
    const info = sizeIconInfo(catId, sizeId);
    if (!info || !SIZE_ICONS[info.key]) return '';
    const n = Math.min(info.count, 3);
    const cls = n >= 3 ? 'opt-icon qty q3' : n === 2 ? 'opt-icon qty' : 'opt-icon';
    return '<div class="' + cls + '">' + SIZE_ICONS[info.key].repeat(n) + '</div>';
  }

  function parsePriceText(text) {
    const str = String(text || '');
    const nums = (str.match(/\d[\d,]*/g) || []).map(n => parseInt(n.replace(/,/g, ''), 10)).filter(Number.isFinite);
    const custom = /custom quote|cotiz/i.test(str) && nums.length === 0;
    if (!nums.length) return { min: 0, max: 0, from: false, custom };
    return {
      min: nums[0],
      max: nums.length > 1 ? nums[1] : nums[0],
      from: /\b(from|desde)\b/i.test(str),
      custom: false
    };
  }

  function normalizePackagePricing(pkg) {
    pkg.priceRangeValues = {};
    Object.keys(pkg.priceRanges || {}).forEach(sizeId => {
      pkg.priceRangeValues[sizeId] = parsePriceText(pkg.priceRanges[sizeId]);
    });
  }

  function normalizeAddonPricing(addon) {
    if (addon.priceByPackage) {
      const values = Object.values(addon.priceByPackage).map(Number);
      addon.customQuote = false;
      addon.priceMin = Math.min(...values);
      addon.priceMax = Math.max(...values);
      addon.priceFrom = false;
      return;
    }
    const parsed = addon.range ? parsePriceText(addon.range) : null;
    const base = Number(addon.price || 0);
    addon.customQuote = Boolean(parsed && parsed.custom);
    addon.priceMin = parsed && !parsed.custom ? parsed.min : base;
    addon.priceMax = parsed && !parsed.custom ? parsed.max : base;
    addon.priceFrom = Boolean((parsed && parsed.from) || FROM_PRICE_EXTRA_IDS.has(addon.id));
  }

  function validSizesForPackage(cat, pkg) {
    if (!cat || !pkg) return [];
    return (cat.sizes || []).filter(size => pkg.prices && pkg.prices[size.id] !== undefined);
  }

  function packagePriceBounds(pkg, sizeId) {
    const range = pkg.priceRangeValues && pkg.priceRangeValues[sizeId];
    if (range) return range;
    const base = Number(pkg.prices && pkg.prices[sizeId]) || 0;
    return { min: base, max: base, from: false, custom: false };
  }

  function addonPriceBounds(addon, pkg = state.selectedPackage) {
    if (addon.priceByPackage) {
      const exact = Number(pkg && addon.priceByPackage[pkg.id]);
      if (exact) return { min: exact, max: exact, from: false, custom: false };
      // No package context (or one outside the map): show the spread as a "from" price.
      return { min: addon.priceMin, max: addon.priceMax, from: true, custom: false };
    }
    return {
      min: Number(addon.priceMin != null ? addon.priceMin : addon.price || 0),
      max: Number(addon.priceMax != null ? addon.priceMax : addon.price || 0),
      from: Boolean(addon.priceFrom),
      custom: Boolean(addon.customQuote)
    };
  }

  function currentValidAddons() {
    const cat = state.selectedCategory;
    const pkg = state.selectedPackage;
    if (!cat) return [];
    return (cat.extras || []).filter(ext => !(ext.onlyFor && !ext.onlyFor.includes(pkg && pkg.id)));
  }

  function packageFromLabel(pkg) {
    const mins = Object.keys(pkg.prices || {}).map(sizeId => packagePriceBounds(pkg, sizeId).min);
    return t('from') + ' ' + fmt(Math.min(...mins));
  }

  function categoryImage(cat) {
    return (cat && (CATEGORY_IMAGES[cat.id] || cat.image)) || 'assets/route-vehicle-detailing.jpg';
  }

  function packageImage(pkg, cat = state.selectedCategory) {
    const fallback = categoryImage(cat);
    return {
      src: pkg && pkg.id ? `${PACKAGE_IMAGE_DIR}${pkg.id}.jpg` : fallback,
      fallback
    };
  }

  function addonImage(addon, cat = state.selectedCategory) {
    return EXTRA_IMAGES[addon.id] || categoryImage(cat);
  }

  // Graceful fallback when a referenced photo is missing (e.g. not yet generated),
  // so cards never render a broken image. Applied to every dynamic <img>.
  const IMG_FALLBACK = 'assets/route-vehicle-detailing.jpg';
  function imgErrAttr(fallback = IMG_FALLBACK) {
    return `onerror="this.onerror=null;this.src='${fallback}'"`;
  }
  const IMG_ERR_ATTR = imgErrAttr();

  // Single source of truth for pricing (summary, live bar & WhatsApp all use this)
  function estimateFor(pkg, size, addons) {
    const base = packagePriceBounds(pkg, size.id);
    let min = base.min;
    let max = base.max;
    let isRange = base.max > base.min;
    let isFrom = base.from;
    let custom = false;

    addons.forEach(addon => {
      const p = addonPriceBounds(addon, pkg);
      if (p.custom) {
        custom = true; // e.g. aluminum tank polishing — custom quote
        return;
      }
      min += p.min;
      max += p.max;
      if (p.max > p.min) isRange = true;
      if (p.from) isFrom = true;
    });

    const showRange = isRange && max > min;
    let label = showRange ? `${fmt(min)} - ${fmt(max)}` : (isFrom ? `${t('from')} ${fmt(min)}` : fmt(min));
    if (custom) label += ' ' + t('customQuote');
    return { min, max, isRange: showRange, custom, isFrom, label };
  }

  // Estimate for the draft line the wizard is currently building.
  function computeEstimate() {
    const pkg = state.selectedPackage;
    const size = state.selectedSize;
    if (!pkg || !size) return null;
    return estimateFor(pkg, size, state.selectedAddons);
  }

  // ── Multi-vehicle cart ──
  // Cart rules (mirror of api/quote.js CART_RULES): every line shares one visit
  // (same address, date and time window → one appointment), duplicate lines are
  // allowed, restricted add-ons apply per line, and the visit books the full
  // day when ANY line uses a full-day package.
  const CART_MAX_ITEMS = 6;
  // Mirror of FULL_DAY_PACKAGES in api/quote.js. Trucks, boats, mobile homes and
  // driveways now book by duration; only paint work still takes the whole day.
  const FULL_DAY_PACKAGE_IDS = new Set(['paint-correction', 'ceramic-protection']);

  function isFullDayLine(line) {
    return FULL_DAY_PACKAGE_IDS.has(line.packageId);
  }

  // Resolve a stored cart line against the live catalog (null when stale).
  function resolveLine(line) {
    if (!line) return null;
    const cat = SERVICES_DATA.categories.find(c => c.id === line.categoryId);
    if (!cat) return null;
    const pkg = cat.packages.find(p => p.id === line.packageId);
    if (!pkg) return null;
    const sizes = validSizesForPackage(cat, pkg);
    const size = sizes.find(sz => sz.id === line.sizeId) || (sizes.length === 1 ? sizes[0] : null);
    if (!size) return null;
    const addons = (line.addonIds || [])
      .map(id => (cat.extras || []).find(extra => extra.id === id))
      .filter(Boolean)
      .filter(addon => !(addon.onlyFor && !addon.onlyFor.includes(pkg.id)));
    return { cat, pkg, size, addons };
  }

  function lineEstimate(line) {
    const resolved = resolveLine(line);
    return resolved ? estimateFor(resolved.pkg, resolved.size, resolved.addons) : null;
  }

  // Total across committed lines plus the draft under construction.
  function cartEstimate() {
    const parts = state.cart.map(lineEstimate).filter(Boolean);
    const draft = computeEstimate();
    if (draft) parts.push(draft);
    if (!parts.length) return null;
    let min = 0, max = 0, isRange = false, isFrom = false, custom = false;
    parts.forEach(part => {
      min += part.min;
      max += part.max;
      if (part.isRange) isRange = true;
      if (part.isFrom) isFrom = true;
      if (part.custom) custom = true;
    });
    const showRange = isRange && max > min;
    let label = showRange ? `${fmt(min)} - ${fmt(max)}` : (isFrom ? `${t('from')} ${fmt(min)}` : fmt(min));
    if (custom) label += ' ' + t('customQuote');
    return { min, max, isRange: showRange, custom, isFrom, label };
  }

  // Every package in the visit, the uncommitted draft included: the calendar has
  // to reserve enough time for all of them back to back.
  function cartPackageIds() {
    const ids = state.cart.map(line => line.packageId);
    if (state.selectedCategory && state.selectedPackage) ids.push(state.selectedPackage.id);
    return ids;
  }

  // Commit the wizard draft as a cart line and reset the draft.
  function commitDraftToCart() {
    const cat = state.selectedCategory;
    const pkg = state.selectedPackage;
    if (!cat || !pkg || state.cart.length >= CART_MAX_ITEMS) return false;
    const sizes = validSizesForPackage(cat, pkg);
    const size = state.selectedSize || (sizes.length === 1 ? sizes[0] : null);
    if (!size) return false;
    state.cart.push({
      lineId: newLineId(),
      categoryId: cat.id,
      packageId: pkg.id,
      sizeId: size.id,
      addonIds: state.selectedAddons.map(addon => addon.id),
      vehicle: state.draftVehicle || blankVehicle()
    });
    state.draftVehicle = blankVehicle();
    clearServiceSelection();
    renderCartPanel();
    saveState();
    return true;
  }

  function removeCartLine(lineId) {
    const index = state.cart.findIndex(line => line.lineId === lineId);
    if (index === -1) return;
    state.cart.splice(index, 1);
    renderCartPanel();
    updateQuoteBar();
    if (state.currentStep >= 4) {
      renderVehicleFields();
      if (!state.cart.length) goToStep(1);
      else loadAvailability();
    }
    validateStep();
    saveState();
  }

  // Pull a committed line back into the wizard draft for editing.
  function editCartLine(lineId, step = 2) {
    const index = state.cart.findIndex(line => line.lineId === lineId);
    if (index === -1) return;
    const line = state.cart[index];
    const resolved = resolveLine(line);
    state.cart.splice(index, 1);
    renderCartPanel();
    if (!resolved) { updateQuoteBar(); return; }
    state.selectedCategory = resolved.cat;
    state.selectedPackage = resolved.pkg;
    state.selectedSize = resolved.size;
    state.selectedAddons = resolved.addons.slice();
    state.pkgType = resolved.pkg.type || 'onetime';
    state.heavyGroup = resolved.cat.id === 'heavy_trucks' ? (resolved.pkg.group || null) : null;
    state.draftVehicle = line.vehicle || blankVehicle();
    state.quizYes = [];
    state.quizPicks = [];
    state.quizOpen = false;
    renderCatFilter();
    renderCategories();
    goToStep(step);
  }

  function renderCartPanel() {
    const panel = document.getElementById('cartPanel');
    if (!panel) return;
    const entries = state.cart
      .map(line => ({ line, resolved: resolveLine(line), est: lineEstimate(line) }))
      .filter(entry => entry.resolved);
    panel.hidden = entries.length === 0;
    const badge = document.getElementById('cartBadge');
    if (badge) badge.textContent = String(entries.length);
    const box = document.getElementById('cartLines');
    if (!box) return;
    box.innerHTML = entries.map(({ line, resolved, est }) => {
      const showSize = validSizesForPackage(resolved.cat, resolved.pkg).length > 1;
      const sub = [showSize ? resolved.size.name : resolved.cat.name]
        .concat(resolved.addons.length ? [resolved.addons.map(a => a.name).join(', ')] : [])
        .join(' · ');
      return `
        <div class="cart-line" data-line-id="${line.lineId}">
          <div class="cart-line-info">
            <span class="cart-line-name">${escapeHTML(resolved.pkg.name)}</span>
            <span class="cart-line-sub">${escapeHTML(sub)}</span>
          </div>
          <span class="cart-line-price">${est ? est.label : ''}</span>
          <div class="cart-line-actions">
            <button type="button" class="cart-line-btn cart-edit" data-line-id="${line.lineId}">${t('cart.edit')}</button>
            <button type="button" class="cart-line-btn cart-remove" data-line-id="${line.lineId}" aria-label="${t('cart.remove')}">✕</button>
          </div>
        </div>`;
    }).join('');
  }

  function setupCart() {
    const box = document.getElementById('cartLines');
    if (box) {
      box.addEventListener('click', event => {
        const btn = event.target.closest('button[data-line-id]');
        if (!btn) return;
        if (btn.classList.contains('cart-remove')) removeCartLine(btn.dataset.lineId);
        else editCartLine(btn.dataset.lineId);
      });
    }
    const addBtn = document.getElementById('btnAddLine');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        if (addBtn.disabled) return;
        if (!commitDraftToCart()) return;
        renderCatFilter();
        renderCategories();
        goToStep(1);
      });
    }
  }

  // ── Live sticky price bar ──
  function setPriceText(el, text, val) {
    if (!el) return;
    el.dataset.val = (val == null) ? '' : String(val);
    el.textContent = text;
  }

  function animatePrice(el, est) {
    if (!el) return;
    const target = est.min;
    const prev = parseInt(el.dataset.val || '0', 10) || 0;
    el.dataset.val = String(target);
    if (prefersReduced || prev === target) { el.textContent = est.label; return; }
    const dur = 520, start = performance.now();
    function tick(now) {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      const cur = Math.round(prev + (target - prev) * eased);
      if (t < 1) { el.textContent = fmt(cur); requestAnimationFrame(tick); }
      else { el.textContent = est.label; }
    }
    requestAnimationFrame(tick);
  }

  function updateQuoteBar() {
    const bar = document.getElementById('quoteBar');
    if (!bar) return;
    // Hide on Schedule/Review steps so it never overlaps the form or summary
    bar.classList.toggle('qbar-hidden', state.currentStep >= 4);
    const valEl = bar.querySelector('.qbar-price');
    const ctxEl = bar.querySelector('.qbar-context');
    const cat = state.selectedCategory;
    const pkg = state.selectedPackage;
    const cartCount = state.cart.length;

    if (!cat && !cartCount) {
      bar.classList.remove('active');
      if (ctxEl) ctxEl.textContent = t('qbar.build');
      setPriceText(valEl, '—', null);
      return;
    }
    bar.classList.add('active');
    if (ctxEl) {
      const draftLabel = pkg ? `${cat.name} · ${pkg.name}` : (cat ? cat.name : '');
      ctxEl.textContent = cartCount
        ? t('cart.count').replace('{n}', String(cartCount + (pkg ? 1 : 0))) + (draftLabel ? ` · ${draftLabel}` : '')
        : draftLabel;
    }

    const est = cartEstimate();
    if (est) animatePrice(valEl, est);
    else if (pkg) setPriceText(valEl, packageFromLabel(pkg), null);
    else if (cat) setPriceText(valEl, t('from') + ' ' + cat.from, null);
    else setPriceText(valEl, '—', null);
  }

  // ── Add-on bundle pricing ──
  function bundlePrice(bundle) {
    const cat = state.selectedCategory;
    let sum = 0, hasVariable = false, custom = false;
    bundle.addons.forEach(id => {
      const a = (cat.extras || []).find(e => e.id === id);
      if (!a) return;
      const p = addonPriceBounds(a);
      if (p.custom) {
        custom = true;
        return;
      }
      sum += p.min;
      if (p.max > p.min || p.from) hasVariable = true;
    });
    return (hasVariable ? t('from') + ' ' : '') + fmt(sum) + (custom ? ' ' + t('customQuote') : '');
  }

  function addonDisplayPrice(addon, pkg) {
    if (addon.customQuote) return t('customQuote');
    if (addon.range) return '+ ' + addon.range;
    const p = addonPriceBounds(addon, pkg);
    return '+ ' + (p.from ? `${t('from')} ${fmt(p.min)}` : fmt(p.min));
  }

  function addonWhatsAppPrice(addon, pkg) {
    if (addon.customQuote) return t('customQuote');
    if (addon.range) return addon.range;
    const p = addonPriceBounds(addon, pkg);
    return p.from ? `${t('from')} ${fmt(p.min)}` : '+' + fmt(p.min);
  }

  function addonBadge(addon) {
    const cat = state.selectedCategory;
    if (state.quizPicks.includes(addon.id)) return `<span class="addon-badge rec-you">${t('badgeRecYou')}</span>`;
    if ((cat.recommended || []).includes(addon.id)) return `<span class="addon-badge rec">${t('badgeRec')}</span>`;
    if ((cat.popular || []).includes(addon.id)) return `<span class="addon-badge pop">${t('badgeChosen')}</span>`;
    return '';
  }

  // ── Scheduling helpers ──
  // Same-day bookings are allowed now that notice is one hour, so the calendar
  // opens today. The server still decides which start times are far enough out.
  function todayISO() {
    return new Date().toISOString().split('T')[0];
  }
  function addDaysISO(iso, days) {
    const d = new Date(`${iso}T12:00:00`);
    d.setDate(d.getDate() + days);
    return d.toISOString().split('T')[0];
  }
  function prettyDate(iso) {
    if (!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString(LANG === 'es' ? 'es-ES' : 'en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }
  function checkCoverage(zip) {
    if (!zip) return { msg: '' };
    if (!/^\d{5}$/.test(zip)) return { msg: t('cov.enterZip') };
    return { msg: t('cov.accepted') };
  }
  function validName(name) {
    const n = (name || '').trim();
    return n.length >= 2 && /[\p{L}]/u.test(n);
  }
  function validStreet(v) {
    return (v || '').trim().length >= 4;
  }
  function validCity(v) {
    return (v || '').trim().length >= 2;
  }
  function validZip(zip) {
    const z = (zip || '').trim();
    return !z || /^\d{5}$/.test(z);
  }
  function phoneDigits(phone) {
    return String(phone || '').replace(/\D/g, '');
  }
  function validPhone(phone) {
    const d = phoneDigits(phone);
    return d.length === 10 || (d.length === 11 && d[0] === '1');
  }
  function validEmail(email) {
    const value = String(email || '').trim();
    return !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }
  function validVehicleText(value) {
    return String(value || '').trim().length >= 2;
  }
  function validVehicleYear(value) {
    const year = Number(value);
    return Number.isInteger(year) && year >= 1900 && year <= new Date().getFullYear() + 1;
  }
  function normalizedPhone(phone) {
    let d = phoneDigits(phone);
    if (d.length === 11 && d[0] === '1') d = d.slice(1);
    if (d.length !== 10) return (phone || '').trim();
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  }
  function vehicleValid(vehicle) {
    const v = vehicle || {};
    return validVehicleText(v.make) && validVehicleText(v.model) && validVehicleYear(v.year);
  }
  function allVehiclesValid() {
    return state.cart.length > 0 && state.cart.every(line => vehicleValid(line.vehicle));
  }
  function contactValid() {
    const s = state.schedule;
    return !!(validName(s.name) && validPhone(s.phone) && validEmail(s.email) &&
      validZip(s.zip) && validStreet(s.address) && validCity(s.city));
  }
  function scheduleValid() {
    const s = state.schedule;
    return !!(contactValid() && allVehiclesValid() && s.date && s.date >= todayISO() && s.timeWindow);
  }

  function blankSchedule() {
    return {
      name: '', phone: '', email: '',
      address: '', unit: '', city: '', zip: '', date: '', timeWindow: '', notes: '', website: ''
    };
  }

  function blankVehicle() {
    return { make: '', model: '', year: '', color: '', plate: '' };
  }

  function newLineId() {
    return `ln-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
  }

  function newSubmissionId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return `lyb-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  // ── Persistence ──
  // Storage key is versioned: v2 invalidates drafts that referenced the retired
  // car-hauler graphite packages / group (now the lubricante-grafito add-on).
  const STORAGE_KEY = 'lyb-quote-v2';
  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        cart: state.cart,
        draft: {
          catId: state.selectedCategory ? state.selectedCategory.id : null,
          pkgType: state.pkgType,
          heavyGroup: state.heavyGroup,
          pkgId: state.selectedPackage ? state.selectedPackage.id : null,
          sizeId: state.selectedSize ? state.selectedSize.id : null,
          addonIds: state.selectedAddons.map(a => a.id),
          vehicle: state.draftVehicle
        },
        submissionId: state.submissionId,
        schedule: state.schedule
      }));
    } catch (e) { /* storage unavailable */ }
  }
  function restoreState() {
    let s;
    try {
      localStorage.removeItem('lyb-quote'); // pre-v2 drafts may reference retired packages
      s = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    } catch (e) { return; }
    if (!s) return;
    if (s.schedule) {
      // Vehicle fields lived inside schedule before the cart refactor; keep
      // only the keys the current schedule shape knows about.
      Object.keys(state.schedule).forEach(key => {
        if (s.schedule[key] != null) state.schedule[key] = s.schedule[key];
      });
    }
    if (s.submissionId) state.submissionId = s.submissionId;
    if (Array.isArray(s.cart)) {
      state.cart = s.cart
        .filter(line => line && resolveLine(line))
        .map(line => ({
          lineId: line.lineId || newLineId(),
          categoryId: line.categoryId,
          packageId: line.packageId,
          sizeId: line.sizeId,
          addonIds: Array.isArray(line.addonIds) ? line.addonIds : [],
          vehicle: { ...blankVehicle(), ...(line.vehicle || {}) }
        }));
    }
    const draft = s.draft || s; // pre-cart saves kept the draft at the top level
    if (draft.vehicle) state.draftVehicle = { ...blankVehicle(), ...draft.vehicle };
    if (!draft.catId) return;
    const cat = SERVICES_DATA.categories.find(c => c.id === draft.catId);
    if (!cat) return;
    state.selectedCategory = cat;
    state.pkgType = draft.pkgType || 'onetime';
    state.heavyGroup = HEAVY_GROUPS.some(g => g.id === draft.heavyGroup) ? draft.heavyGroup : null;
    if (draft.pkgId) state.selectedPackage = cat.packages.find(p => p.id === draft.pkgId) || null;
    if (draft.sizeId && state.selectedPackage) {
      const vs = validSizesForPackage(cat, state.selectedPackage);
      state.selectedSize = vs.find(sz => sz.id === draft.sizeId) || null;
    }
    if (Array.isArray(draft.addonIds)) {
      const valid = currentValidAddons();
      state.selectedAddons = draft.addonIds.map(id => valid.find(a => a.id === id)).filter(Boolean);
    }
  }

  // ──────────────────────────────────────────────
  // STATE MANAGEMENT
  // ──────────────────────────────────────────────
  const state = {
    currentStep: 1,
    totalSteps: 5,
    catFilter: 'all',
    pkgType: 'onetime',
    heavyGroup: null,
    selectedCategory: null,
    selectedPackage: null,
    selectedSize: null,
    selectedAddons: [],
    cart: [],
    draftVehicle: { make: '', model: '', year: '', color: '', plate: '' },
    quizYes: [],
    quizPicks: [],
    quizOpen: false,
    policiesAccepted: false,
    submitting: false,
    submitError: false,
    completed: false,
    confirmedBooking: null,
    availability: { cartKey: '', loading: false, error: '', bookingMode: '', durationMinutes: 0, deposit: 0, dates: [] },
    submissionId: newSubmissionId(),
    schedule: blankSchedule()
  };

  // ──────────────────────────────────────────────
  // DOM ELEMENTS
  // ──────────────────────────────────────────────
  const navbar = document.getElementById('navbar');
  const ws1 = document.getElementById('ws1');
  const ws2 = document.getElementById('ws2');
  const ws3 = document.getElementById('ws3');
  const ws4 = document.getElementById('ws4');

  const catGrid = document.getElementById('catGrid');
  const optGrid = document.getElementById('optGrid');
  const sizeGrid = document.getElementById('sizeGrid');
  const addonGrid = document.getElementById('addonGrid');
  const summaryBox = document.getElementById('summaryBox');

  const sizeSection = document.getElementById('sizeSection');
  const addonSection = document.getElementById('addonSection');

  const btnBack = document.getElementById('btnBack');
  const btnNext = document.getElementById('btnNext');
  const stepCircles = document.querySelectorAll('.step-circle');
  const stepLines = document.querySelectorAll('.step-line');

  // ──────────────────────────────────────────────
  // NAVIGATION & SCROLL EVENTS
  // ──────────────────────────────────────────────
  function handleNavScroll() {
    if (window.scrollY > 60) {
      navbar.classList.add('scrolled');
    } else {
      navbar.classList.remove('scrolled');
    }
  }
  window.addEventListener('scroll', handleNavScroll, { passive: true });

  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
      const href = this.getAttribute('href');
      if (!href || href.length < 2) return; // ignore bare "#"
      const target = document.querySelector(href);
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth' });
      }
    });
  });

  // Click + keyboard (Enter / Space) activation for custom interactive cards
  function bindActivation(el, handler) {
    el.addEventListener('click', handler);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        handler();
      }
    });
  }

  function setupContactLinks() {
    document.querySelectorAll('[data-phone-link], [data-phone-display]').forEach(el => {
      el.setAttribute('href', 'tel:' + PHONE_TEL);
    });
    document.querySelectorAll('[data-phone-display]').forEach(el => {
      el.textContent = PHONE_DISPLAY;
    });
    document.querySelectorAll('[data-whatsapp-float]').forEach(el => {
      el.setAttribute('href', `https://wa.me/${PHONE_E164}?text=${encodeURIComponent(t('wa.quick'))}`);
      el.setAttribute('aria-label', t('waFloat.aria'));
    });
  }

  // ──────────────────────────────────────────────
  // THEME TOGGLE (light / dark)
  // ──────────────────────────────────────────────
  function setupThemeToggle() {
    const root = document.documentElement;
    const btn = document.getElementById('themeToggle');
    if (!btn) return;

    const apply = (theme) => {
      root.setAttribute('data-theme', theme);
      btn.setAttribute('aria-pressed', String(theme === 'light'));
      btn.setAttribute('aria-label', theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode');
    };

    apply(root.getAttribute('data-theme') === 'light' ? 'light' : 'dark');

    btn.addEventListener('click', () => {
      const next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      try { localStorage.setItem('lyb-theme', next); } catch (e) { /* storage unavailable */ }
      apply(next);
    });
  }

  // ──────────────────────────────────────────────
  // SCROLL REVEAL ANIMATION
  // ──────────────────────────────────────────────
  const revealElements = document.querySelectorAll('.reveal');
  const revealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          revealObserver.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
  );
  revealElements.forEach(el => revealObserver.observe(el));

  // ──────────────────────────────────────────────
  // DYNAMIC COMPONENT RENDERING
  // ──────────────────────────────────────────────

  // Step 1: Intent filter chips
  function renderCatFilter() {
    const wrap = document.getElementById('catFilter');
    if (!wrap) return;
    wrap.innerHTML = CLUSTER_FILTERS.map(f =>
      `<button type="button" class="chip ${state.catFilter === f.id ? 'active' : ''}" data-filter="${f.id}">${t('filter.' + f.id)}</button>`
    ).join('');
    wrap.querySelectorAll('.chip').forEach(chip => {
      chip.addEventListener('click', () => {
        state.catFilter = chip.dataset.filter;
        renderCatFilter();
        renderCategories();
      });
    });
  }

  // Both resets touch only the wizard draft — never state.cart.
  function resetFromCategory(category) {
    state.selectedCategory = category;
    state.selectedPackage = null;
    state.selectedSize = null;
    state.selectedAddons = [];
    state.heavyGroup = null;
    state.pkgType = 'onetime';
    state.quizYes = [];
    state.quizPicks = [];
    state.quizOpen = false;
    state.draftVehicle = blankVehicle();
  }

  function clearServiceSelection() {
    state.selectedCategory = null;
    state.selectedPackage = null;
    state.selectedSize = null;
    state.selectedAddons = [];
    state.heavyGroup = null;
    state.pkgType = 'onetime';
    state.quizYes = [];
    state.quizPicks = [];
    state.quizOpen = false;
    state.draftVehicle = blankVehicle();
  }

  // Step 1: Render Categories (filtered by intent)
  function renderCategories() {
    const cats = SERVICES_DATA.categories
      .filter(c => state.catFilter === 'all' || c.cluster === state.catFilter)
      .sort((a, b) => CATEGORY_ORDER.indexOf(a.id) - CATEGORY_ORDER.indexOf(b.id));
    const isSel = (cat) => state.selectedCategory && state.selectedCategory.id === cat.id;

    catGrid.innerHTML = cats.map(cat => `
      <div class="cat-card ${isSel(cat) ? 'selected' : ''}" data-id="${cat.id}" role="radio" tabindex="0" aria-checked="${isSel(cat)}" aria-label="${cat.name}, ${t('from').toLowerCase()} ${cat.from}">
        <div class="check-badge">${CHECK_SVG}</div>
        <img src="${cat.image}" alt="${cat.name}" loading="lazy" decoding="async" />
        <div class="cat-card-label">
          <span class="cat-card-name">${cat.name}</span>
          <span class="cat-card-from">${t('from')} ${cat.from}</span>
        </div>
      </div>
    `).join('');

    catGrid.querySelectorAll('.cat-card').forEach(card => {
      bindActivation(card, () => {
        const category = SERVICES_DATA.categories.find(c => c.id === card.dataset.id);
        if (!state.selectedCategory || state.selectedCategory.id !== category.id) {
          resetFromCategory(category);
        }
        renderCategories();
        validateStep();
        updateQuoteBar();
      });
      attachSpotlight(card);
    });
  }

  function selectPackage(pkgId) {
    const pkg = state.selectedCategory.packages.find(p => p.id === pkgId);
    if (!pkg) return;
    if (!state.selectedPackage || state.selectedPackage.id !== pkg.id) {
      state.selectedPackage = pkg;
      state.selectedSize = null;
      state.selectedAddons = [];
      state.quizYes = [];
      state.quizPicks = [];
      state.quizOpen = false;
    }
    renderPackages();
    validateStep();
    updateQuoteBar();
  }

  function optCardHTML(pkg) {
    const isSel = state.selectedPackage && state.selectedPackage.id === pkg.id;
    const img = packageImage(pkg);
    const includes = packageIncludesHTML(pkg);
    return `
      <div class="opt-card has-media ${isSel ? 'selected' : ''}" data-id="${pkg.id}" role="radio" tabindex="0" aria-checked="${isSel}">
        <div class="opt-radio"></div>
        <img class="opt-img" src="${img.src}" alt="" loading="lazy" decoding="async" ${imgErrAttr(img.fallback)} />
        <div class="opt-text">
          <span class="opt-name">${pkg.name}</span>
          <span class="opt-desc">${pkg.description}</span>
        </div>
        ${includes}
        <span class="opt-price">${packageFromLabel(pkg)}</span>
      </div>`;
  }

  function packageIncludesHTML(pkg) {
    const items = Array.isArray(pkg.includes) ? pkg.includes : [];
    const firstItems = items.slice(0, 4).map(x => `<li>${CHECK_SVG}<span>${x}</span></li>`).join('');
    const remainingItems = items.slice(4).map(x => `<li>${CHECK_SVG}<span>${x}</span></li>`).join('');
    return `
      <ul class="package-includes">${firstItems}</ul>
      ${remainingItems ? `
        <details class="package-details">
          <summary>${t('package.viewAll')}</summary>
          <ul class="package-includes">${remainingItems}</ul>
        </details>` : ''}`;
  }

  function compareCardsHTML(pkgs) {
    return pkgs.map((pkg, i) => {
      const featured = pkgs.length === 3 && i === 1;
      const isSel = state.selectedPackage && state.selectedPackage.id === pkg.id;
      const img = packageImage(pkg);
      return `
        <div class="compare-card ${featured ? 'featured' : ''} ${isSel ? 'selected' : ''}" data-id="${pkg.id}" role="radio" tabindex="0" aria-checked="${isSel}">
          ${featured ? `<span class="compare-flag">${t('mostPopular')}</span>` : ''}
          <img class="compare-img" src="${img.src}" alt="" loading="lazy" decoding="async" ${imgErrAttr(img.fallback)} />
          <span class="compare-name">${pkg.name}</span>
          <span class="compare-price">${packageFromLabel(pkg)}</span>
          <p class="compare-desc">${pkg.description}</p>
          ${packageIncludesHTML(pkg)}
          <span class="compare-cta">${isSel ? t('selected') : t('choosePlan')}</span>
        </div>`;
    }).join('');
  }

  // Step 2: Render Packages (type toggle, heavy-truck subtype, compare view)
  function renderPackages() {
    if (!state.selectedCategory) return;
    const cat = state.selectedCategory;

    // A. One-time / Membership toggle
    const typeToggle = document.getElementById('pkgTypeToggle');
    const hasOnetime = cat.packages.some(p => p.type === 'onetime');
    const hasMembership = cat.packages.some(p => p.type === 'membership');
    if (typeToggle) {
      if (hasOnetime && hasMembership) {
        typeToggle.style.display = '';
        typeToggle.innerHTML = `
          <button type="button" class="seg ${state.pkgType === 'onetime' ? 'active' : ''}" data-type="onetime">${t('oneTime')}</button>
          <button type="button" class="seg ${state.pkgType === 'membership' ? 'active' : ''}" data-type="membership">${t('membership')}</button>`;
        typeToggle.querySelectorAll('.seg').forEach(b => b.addEventListener('click', () => {
          if (state.pkgType === b.dataset.type) return;
          state.pkgType = b.dataset.type;
          state.selectedPackage = null;
          state.selectedSize = null;
          state.selectedAddons = [];
          renderPackages();
          validateStep();
          updateQuoteBar();
        }));
      } else {
        typeToggle.style.display = 'none';
        state.pkgType = hasOnetime ? 'onetime' : 'membership';
      }
    }

    let pkgs = cat.packages.filter(p => p.type === state.pkgType);

    // B. Heavy-truck subtype selector
    const groupSel = document.getElementById('heavyGroupSelect');
    if (groupSel) {
      if (cat.groupBy) {
        const groups = HEAVY_GROUPS.filter(g => cat.packages.some(p => p.group === g.id));
        if (!state.heavyGroup || !groups.some(g => g.id === state.heavyGroup)) state.heavyGroup = groups[0].id;
        groupSel.style.display = '';
        groupSel.innerHTML = groups.map(g =>
          `<button type="button" class="chip ${state.heavyGroup === g.id ? 'active' : ''}" data-group="${g.id}">${loc(g.label)}</button>`
        ).join('');
        groupSel.querySelectorAll('.chip').forEach(b => b.addEventListener('click', () => {
          if (state.heavyGroup === b.dataset.group) return;
          state.heavyGroup = b.dataset.group;
          if (state.selectedPackage && state.selectedPackage.group !== state.heavyGroup) {
            state.selectedPackage = null;
            state.selectedSize = null;
            state.selectedAddons = [];
            state.quizYes = [];
            state.quizPicks = [];
            state.quizOpen = false;
          }
          renderPackages();
          validateStep();
        }));
        pkgs = pkgs.filter(p => p.group === state.heavyGroup);
      } else {
        groupSel.style.display = 'none';
      }
    }

    // C. Render — compare view for tiered categories, else option cards
    const useCompare = cat.compareView && state.pkgType === 'onetime' && pkgs.length >= 2;
    optGrid.className = useCompare ? 'compare-grid' : 'option-grid';
    optGrid.innerHTML = useCompare ? compareCardsHTML(pkgs) : pkgs.map(optCardHTML).join('');

    optGrid.querySelectorAll('[data-id]').forEach(card => {
      bindActivation(card, () => selectPackage(card.dataset.id));
      if (useCompare) attachSpotlight(card);
    });
    optGrid.querySelectorAll('.package-details').forEach(details => {
      details.addEventListener('click', e => e.stopPropagation());
      details.addEventListener('keydown', e => e.stopPropagation());
    });

    updateQuoteBar();
  }

  function toggleAddon(addonId) {
    const addon = currentValidAddons().find(a => a.id === addonId);
    if (!addon) return;
    const i = state.selectedAddons.findIndex(a => a.id === addonId);
    if (i > -1) state.selectedAddons.splice(i, 1);
    else state.selectedAddons.push(addon);
  }

  // Recommender UI — recommend button, bundles, quiz panel
  function renderRecoUI() {
    const cat = state.selectedCategory;
    const validAddons = currentValidAddons();
    const validIds = new Set(validAddons.map(a => a.id));

    const recoBar = document.getElementById('recoBar');
    const bundleRow = document.getElementById('bundleRow');
    const quizPanel = document.getElementById('quizPanel');

    const hasQuiz = (cat.quiz || []).length > 0;
    const bundles = (cat.bundles || []).filter(b => b.addons.every(id => validIds.has(id)));

    // Recommend button
    if (recoBar) {
      if (hasQuiz) {
        recoBar.style.display = '';
        recoBar.innerHTML = `
          <button type="button" class="reco-btn ${state.quizOpen ? 'open' : ''}" id="recoToggle">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M12 3l1.9 5.8H20l-4.9 3.6 1.9 5.8L12 14.6 6 18.2l1.9-5.8L3 8.8h6.1z"/></svg>
            ${t('recommendExtras')}
          </button>
          <span class="reco-hint">${t('recoHint')}</span>`;
        document.getElementById('recoToggle').addEventListener('click', () => {
          state.quizOpen = !state.quizOpen;
          renderRecoUI();
        });
      } else {
        recoBar.style.display = 'none';
        recoBar.innerHTML = '';
      }
    }

    // Bundles
    if (bundleRow) {
      if (bundles.length) {
        bundleRow.style.display = '';
        bundleRow.innerHTML = bundles.map(b => {
          const allSel = b.addons.every(id => state.selectedAddons.some(a => a.id === id));
          return `
            <div class="bundle-card ${allSel ? 'added' : ''}" data-bundle="${b.id}" role="button" tabindex="0">
              <div class="bundle-top">
                <span class="bundle-name">${loc(b.name)}</span>
                <span class="bundle-price">${bundlePrice(b)}</span>
              </div>
              <p class="bundle-desc">${loc(b.desc)}</p>
              <span class="bundle-action">${allSel ? t('bundleRemove') : t('bundleAdd')}</span>
            </div>`;
        }).join('');
        bundleRow.querySelectorAll('.bundle-card').forEach(card => {
          bindActivation(card, () => {
            const b = cat.bundles.find(x => x.id === card.dataset.bundle);
            const allSel = b.addons.every(id => state.selectedAddons.some(a => a.id === id));
            b.addons.forEach(id => {
              const has = state.selectedAddons.some(a => a.id === id);
              if (allSel && has) toggleAddon(id);
              else if (!allSel && !has) toggleAddon(id);
            });
            renderSizesAndAddons();
            validateStep();
          });
        });
      } else {
        bundleRow.style.display = 'none';
        bundleRow.innerHTML = '';
      }
    }

    // Quiz panel
    if (quizPanel) {
      if (hasQuiz && state.quizOpen) {
        quizPanel.style.display = '';
        quizPanel.innerHTML = `
          <p class="quiz-title">${t('quizTitle')}</p>
          <div class="quiz-qs">
            ${cat.quiz.map(q => `<button type="button" class="quiz-chip ${state.quizYes.includes(q.id) ? 'yes' : ''}" data-q="${q.id}">${loc(q.q)}</button>`).join('')}
          </div>
          <div class="quiz-actions">
            <button type="button" class="btn btn-primary btn-sm" id="quizApply">${t('quizApply')}</button>
            <button type="button" class="btn btn-secondary btn-sm" id="quizClear">${t('quizClear')}</button>
          </div>`;
        quizPanel.querySelectorAll('.quiz-chip').forEach(c => c.addEventListener('click', () => {
          const id = c.dataset.q;
          const i = state.quizYes.indexOf(id);
          if (i > -1) state.quizYes.splice(i, 1); else state.quizYes.push(id);
          renderRecoUI();
        }));
        document.getElementById('quizApply').addEventListener('click', applyQuiz);
        document.getElementById('quizClear').addEventListener('click', () => {
          state.quizYes = [];
          state.quizPicks = [];
          renderSizesAndAddons();
          validateStep();
        });
      } else {
        quizPanel.style.display = 'none';
        quizPanel.innerHTML = '';
      }
    }
  }

  function applyQuiz() {
    const cat = state.selectedCategory;
    const picks = new Set();
    cat.quiz.forEach(q => { if (state.quizYes.includes(q.id)) q.addons.forEach(a => picks.add(a)); });
    state.quizPicks = [...picks];

    const valid = currentValidAddons();
    state.quizPicks.forEach(id => {
      const addon = valid.find(a => a.id === id);
      if (addon && !state.selectedAddons.some(a => a.id === id)) state.selectedAddons.push(addon);
    });
    state.quizOpen = false;
    renderSizesAndAddons();
    validateStep();
    const grid = document.getElementById('addonGrid');
    if (grid) grid.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // Step 3: Render Sizes, Recommender & Add-ons
  function renderSizesAndAddons() {
    if (!state.selectedCategory || !state.selectedPackage) return;

    const cat = state.selectedCategory;
    const pkg = state.selectedPackage;

    // A. Sizes
    const validSizes = validSizesForPackage(cat, pkg);
    if (validSizes.length > 1) {
      sizeSection.style.display = 'block';
      sizeGrid.innerHTML = validSizes.map(size => {
        const displayPrice = pkg.priceRanges && pkg.priceRanges[size.id]
          ? pkg.priceRanges[size.id]
          : fmt(pkg.prices[size.id]);
        const isSel = state.selectedSize && state.selectedSize.id === size.id;
        const iconHTML = sizeIconHTML(cat.id, size.id);
        return `
          <div class="opt-card ${iconHTML ? 'has-icon' : ''} ${isSel ? 'selected' : ''}" data-id="${size.id}" role="radio" tabindex="0" aria-checked="${isSel}">
            <div class="opt-radio"></div>
            ${iconHTML}
            <span class="opt-name">${size.name}</span>
            <span class="opt-price">${displayPrice}</span>
          </div>`;
      }).join('');
      sizeGrid.querySelectorAll('.opt-card').forEach(card => {
        bindActivation(card, () => {
          state.selectedSize = validSizes.find(s => s.id === card.dataset.id);
          renderSizesAndAddons();
          validateStep();
          updateQuoteBar();
        });
      });
    } else {
      state.selectedSize = validSizes[0] || { id: 'standard', name: t('standard') };
      sizeSection.style.display = 'none';
      sizeGrid.innerHTML = '';
    }

    // B. Add-ons (with recommender)
    const validAddons = currentValidAddons();
    if (validAddons.length > 0) {
      addonSection.style.display = 'block';
      renderRecoUI();
      addonGrid.innerHTML = validAddons.map(addon => {
        const isSel = state.selectedAddons.some(a => a.id === addon.id);
        const priceLabel = addonDisplayPrice(addon);
        const badge = addonBadge(addon);
        return `
          <div class="addon-card ${isSel ? 'selected' : ''} ${state.quizPicks.includes(addon.id) ? 'rec-you' : ''}" data-id="${addon.id}" role="checkbox" tabindex="0" aria-checked="${isSel}">
            <div class="addon-check">${CHECK_SVG}</div>
            <img class="addon-img" src="${addonImage(addon)}" alt="" loading="lazy" decoding="async" ${IMG_ERR_ATTR} />
            <div class="addon-text">
              <span class="addon-name">${addon.name}</span>
              ${badge}
            </div>
            <span class="addon-price">${priceLabel}</span>
          </div>`;
      }).join('');
      addonGrid.querySelectorAll('.addon-card').forEach(card => {
        bindActivation(card, () => {
          toggleAddon(card.dataset.id);
          renderSizesAndAddons();
          validateStep();
          updateQuoteBar();
        });
      });
    } else {
      addonSection.style.display = 'none';
      addonGrid.innerHTML = '';
    }

    // Empty-state notice when there is nothing to configure
    const hasVisibleSizes = validSizes.length > 1;
    const hasVisibleAddons = validAddons.length > 0;
    let noticeEl = document.getElementById('step3Notice');
    if (!hasVisibleSizes && !hasVisibleAddons) {
      if (!noticeEl) {
        noticeEl = document.createElement('div');
        noticeEl.id = 'step3Notice';
        noticeEl.className = 'empty-state';
        noticeEl.textContent = t('emptyStep3');
        ws3.appendChild(noticeEl);
      }
    } else if (noticeEl) {
      noticeEl.remove();
    }

    updateQuoteBar();
  }

  function selectedAvailabilityDay() {
    return state.availability.dates.find(item => item.date === state.schedule.date) || null;
  }

  function renderAvailability() {
    const dateEl = document.getElementById('schedDate');
    const messageEl = document.getElementById('availabilityMessage');
    const timeField = document.getElementById('timeWindowField');
    const timeRow = timeField && timeField.querySelector('.time-row');
    const fullDayHint = document.getElementById('fullDayHint');
    if (!dateEl) return;

    dateEl.disabled = state.availability.loading || Boolean(state.availability.error) || !state.availability.dates.length;
    const options = [`<option value="">${escapeHTML(state.availability.loading ? t('availability.loading') : t('availability.chooseDate'))}</option>`];
    state.availability.dates.forEach(item => {
      options.push(`<option value="${item.date}">${escapeHTML(prettyDate(item.date))}</option>`);
    });
    dateEl.innerHTML = options.join('');
    if (state.availability.dates.some(item => item.date === state.schedule.date)) dateEl.value = state.schedule.date;
    else {
      state.schedule.date = '';
      state.schedule.timeWindow = '';
    }

    if (messageEl) {
      const empty = !state.availability.loading && !state.availability.error && !state.availability.dates.length;
      messageEl.textContent = state.availability.error || (empty ? t('availability.empty') : (state.availability.dates.length ? t('availability.ready') : ''));
      messageEl.className = `availability-msg${state.availability.error ? ' error' : (state.availability.dates.length ? ' success' : '')}`;
    }

    const fullDay = state.availability.bookingMode === 'full_day';
    if (timeRow) timeRow.hidden = fullDay;
    if (fullDayHint) fullDayHint.hidden = !fullDay;
    if (fullDay) state.schedule.timeWindow = state.schedule.date ? 'full_day' : '';

    // Memberships need 48h of notice; reflect that in the date hint.
    const dateHint = document.querySelector('#timeWindowField')?.parentElement?.querySelector('[data-i18n="form.dateHint"]')
      || document.querySelector('[data-i18n="form.dateHint"]');
    if (dateHint) {
      const membership = cartPackageIds().some(id => /membresia|membership|-2x$|-4x$/.test(id));
      dateHint.textContent = t(membership ? 'form.dateHintMembership' : 'form.dateHint');
    }

    const durationHint = document.getElementById('durationHint');
    if (durationHint) {
      const minutes = state.availability.durationMinutes || 0;
      durationHint.hidden = fullDay || !minutes;
      durationHint.textContent = minutes ? t('form.duration').replace('{duration}', durationLabel(minutes)) : '';
    }

    const day = selectedAvailabilityDay();
    // Start times come from the calendar, so the chips are rebuilt per day.
    if (timeRow && !fullDay) {
      const slots = day ? day.slots : [];
      if (!slots.includes(state.schedule.timeWindow)) state.schedule.timeWindow = '';
      timeRow.innerHTML = slots.map(slot =>
        `<button type="button" class="time-chip${slot === state.schedule.timeWindow ? ' active' : ''}" data-window="${escapeHTML(slot)}">${escapeHTML(clockLabel(minutesFromTime(slot)))}</button>`
      ).join('');
    }
    validateStep();
  }

  async function loadAvailability(force = false) {
    const packageIds = cartPackageIds();
    if (!packageIds.length) return;
    const cartKey = packageIds.join('|');
    if (!force && state.availability.cartKey === cartKey && (state.availability.loading || state.availability.dates.length)) {
      renderAvailability();
      return;
    }

    let cartChangedNotice = false;
    if (state.availability.cartKey !== cartKey) {
      cartChangedNotice = Boolean(state.availability.cartKey && state.schedule.date);
      state.schedule.date = '';
      state.schedule.timeWindow = '';
    }
    state.availability = { cartKey, loading: true, error: '', bookingMode: '', durationMinutes: 0, deposit: 0, dates: [] };
    renderAvailability();
    try {
      const from = todayISO();
      const response = await fetch('/api/availability', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packageIds, from, to: addDaysISO(from, 59) })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.error || `Calendar request failed (${response.status})`);
      if (cartPackageIds().join('|') !== cartKey) return; // cart changed mid-flight
      state.availability = {
        cartKey,
        loading: false,
        error: '',
        bookingMode: result.bookingMode,
        durationMinutes: Number(result.durationMinutes) || 0,
        deposit: Number(result.deposit) || 0,
        dates: Array.isArray(result.dates) ? result.dates : []
      };
    } catch (error) {
      state.availability = { cartKey, loading: false, error: t('availability.error'), bookingMode: '', durationMinutes: 0, deposit: 0, dates: [] };
    }
    renderAvailability();
    if (cartChangedNotice) {
      const messageEl = document.getElementById('availabilityMessage');
      if (messageEl) {
        messageEl.textContent = t('availability.cartChanged');
        messageEl.className = 'availability-msg error';
      }
    }
  }

  // Step 4: one vehicle fieldset per cart line.
  function renderVehicleFields() {
    const box = document.getElementById('vehicleFields');
    if (!box) return;
    const maxYear = String(new Date().getFullYear() + 1);
    box.innerHTML = state.cart.map((line, index) => {
      const resolved = resolveLine(line);
      const v = line.vehicle || blankVehicle();
      const lid = line.lineId;
      const legend = `${t('form.vehicleN').replace('{n}', String(index + 1))}${resolved ? ` — ${resolved.pkg.name}` : ''}`;
      const field = (key, labelKey, phKey, opts = {}) => `
        <div class="field ${opts.full ? 'field-full' : ''}">
          <label for="vf-${key}-${lid}"><span>${t(labelKey)}</span> ${opts.optional ? `<span class="opt">${t('form.notesOpt')}</span>` : '<span class="req">*</span>'}</label>
          <input type="${opts.type || 'text'}" id="vf-${key}-${lid}" data-line-id="${lid}" data-vkey="${key}"
            value="${escapeHTML(v[key])}" autocomplete="off" maxlength="${opts.maxlength || 60}"
            ${opts.type === 'number' ? `inputmode="numeric" min="1900" max="${maxYear}"` : ''}
            placeholder="${escapeHTML(t(phKey))}" />
        </div>`;
      return `
        <fieldset class="vehicle-fieldset" data-line-id="${lid}">
          <legend>${escapeHTML(legend)}</legend>
          <div class="vehicle-fieldset-grid">
            ${field('make', 'form.vehicleMake', 'form.vehicleMakePh')}
            ${field('model', 'form.vehicleModel', 'form.vehicleModelPh')}
            ${field('year', 'form.vehicleYear', 'form.vehicleYearPh', { type: 'number', maxlength: 4 })}
            ${field('color', 'form.vehicleColor', 'form.vehicleColorPh', { optional: true, maxlength: 40 })}
            ${field('plate', 'form.vehiclePlate', 'form.vehiclePlatePh', { optional: true, maxlength: 16, full: true })}
          </div>
        </fieldset>`;
    }).join('');
  }

  // Step 4: Schedule & details form wiring (bound once)
  function setupSchedule() {
    const vehicleBox = document.getElementById('vehicleFields');
    if (vehicleBox) {
      vehicleBox.addEventListener('input', event => {
        const el = event.target;
        const lid = el.dataset && el.dataset.lineId;
        const key = el.dataset && el.dataset.vkey;
        if (!lid || !key) return;
        const line = state.cart.find(item => item.lineId === lid);
        if (!line) return;
        let value = el.value;
        if (key === 'year') value = value.replace(/\D/g, '').slice(0, 4);
        if (key === 'plate') value = value.toUpperCase().replace(/[^A-Z0-9 -]/g, '').slice(0, 16);
        if (!line.vehicle) line.vehicle = blankVehicle();
        line.vehicle[key] = value;
        if (el.value !== value) el.value = value;
        validateStep();
      });
    }

    const bind = (id, key) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', () => {
        let value = el.value;
        if (key === 'zip') value = value.replace(/\D/g, '').slice(0, 5);
        state.schedule[key] = value;
        if (el.value !== value) el.value = value;
        if (key === 'zip') updateCoverage();
        validateStep();
      });
      if (key === 'phone') {
        el.addEventListener('blur', () => {
          if (!validPhone(el.value)) return;
          el.value = normalizedPhone(el.value);
          state.schedule.phone = el.value;
          validateStep();
        });
      }
    };
    bind('schedName', 'name');
    bind('schedPhone', 'phone');
    bind('schedEmail', 'email');
    bind('schedAddress', 'address');
    bind('schedUnit', 'unit');
    bind('schedCity', 'city');
    bind('schedZip', 'zip');
    bind('schedNotes', 'notes');
    bind('schedWebsite', 'website');

    const dateEl = document.getElementById('schedDate');
    if (dateEl) dateEl.addEventListener('change', () => {
      state.schedule.date = dateEl.value;
      state.schedule.timeWindow = state.availability.bookingMode === 'full_day' && dateEl.value ? 'full_day' : '';
      renderAvailability();
    });

    // Start-time chips are rebuilt whenever the day changes, so listen on the row.
    const timeRow = document.getElementById('timeRow');
    if (timeRow) timeRow.addEventListener('click', event => {
      const chip = event.target.closest('.time-chip');
      if (!chip || chip.disabled) return;
      state.schedule.timeWindow = chip.dataset.window;
      timeRow.querySelectorAll('.time-chip').forEach(x => x.classList.toggle('active', x === chip));
      validateStep();
    });

    const policyEl = document.getElementById('policyAccept');
    if (policyEl) {
      policyEl.checked = state.policiesAccepted;
      policyEl.addEventListener('change', () => {
        state.policiesAccepted = policyEl.checked;
        validateStep();
      });
    }
  }

  function updateCoverage() {
    const el = document.getElementById('coverageMsg');
    if (!el) return;
    const r = checkCoverage(state.schedule.zip);
    el.textContent = r.msg;
    el.className = 'coverage-msg' + (r.msg ? ' show' : '');
  }

  function restoreScheduleInputs() {
    const s = state.schedule;
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.value = v || ''; };
    renderVehicleFields();
    set('schedName', s.name);
    set('schedPhone', s.phone);
    set('schedEmail', s.email);
    set('schedAddress', s.address);
    set('schedUnit', s.unit);
    set('schedCity', s.city);
    set('schedZip', s.zip);
    set('schedDate', s.date);
    set('schedNotes', s.notes);
    set('schedWebsite', s.website);
    renderAvailability();
    updateCoverage();
  }

  // Step 5: Render Review & Estimate — one block per cart line plus shared visit data.
  function renderSummary() {
    const entries = state.cart
      .map(line => ({ line, resolved: resolveLine(line), est: lineEstimate(line) }))
      .filter(entry => entry.resolved);
    if (!entries.length) {
      summaryBox.innerHTML = `<div class="empty-state">${t('sum.empty')}</div>`;
      return;
    }

    const s = state.schedule;
    const total = cartEstimate();
    const deposit = state.availability.deposit || 0;
    const many = entries.length > 1;
    const row = (lab, val) => val ? `<div class="summary-row"><span class="lab">${escapeHTML(lab)}</span><span class="val">${escapeHTML(val)}</span></div>` : '';
    const scheduleVal = [prettyDate(s.date), timeWindowLabel(s.timeWindow)].filter(Boolean).join(' · ');

    const lineBlocks = entries.map(({ line, resolved, est }, index) => {
      const { cat, pkg, size, addons } = resolved;
      const v = line.vehicle || blankVehicle();
      const showSizeRow = validSizesForPackage(cat, pkg).length > 1;
      const vehIcon = sizeIconHTML(cat.id, size.id);
      const name = `${many ? `${index + 1}. ` : ''}${pkg.name}`;
      const inclusionsHtml = pkg.includes.map(inc => `<li>${CHECK_SVG}<span>${inc}</span></li>`).join('');
      return `
      <div class="summary-line">
        <div class="summary-vehicle">${vehIcon || ''}<div class="summary-vehicle-text"><span class="sv-name">${escapeHTML(name)}</span><span class="sv-sub">${escapeHTML(showSizeRow ? size.name : cat.name)}</span></div><span class="sv-price">${est ? est.label : ''}</span></div>
        ${addons.length ? row(t('sum.addons'), addons.map(a => `${a.name} (${addonDisplayPrice(a, pkg).replace(/^\+ /, '+')})`).join(', ')) : ''}
        ${row(t('sum.vehicle'), [v.year, v.make, v.model, v.color].filter(Boolean).join(' · '))}
        ${row(t('sum.plate'), v.plate)}
        <details class="summary-includes">
          <summary>${t('sum.included')}</summary>
          <ul class="includes-list">${inclusionsHtml}</ul>
        </details>
      </div>`;
    }).join('');

    summaryBox.innerHTML = `
      ${lineBlocks}
      ${row(t('sum.name'), s.name)}
      ${row(t('sum.email'), s.email)}
      ${row(t('sum.address'), [s.address, s.unit].filter(Boolean).join(', '))}
      ${row(t('sum.area'), [s.city, s.zip].filter(Boolean).join(' '))}
      ${row(t('sum.time'), scheduleVal)}
      ${row(t('sum.notes'), s.notes)}
      <div class="summary-total">
        <span class="lab">${t('sum.total')}</span>
        <span class="val">${total ? total.label : '—'}</span>
      </div>
      ${deposit ? `<div class="summary-deposit">
        <div class="summary-row"><span class="lab">${escapeHTML(t('deposit.label'))}</span><span class="val">$${deposit}</span></div>
        <div class="summary-note">${escapeHTML(t('deposit.hint').replace('{amount}', String(deposit)))}</div>
      </div>` : ''}
      <div class="summary-note">
        ${t('sum.disclaimer')}
      </div>`;
  }

  // ──────────────────────────────────────────────
  // WIZARD NAVIGATION & VALIDATION
  // ──────────────────────────────────────────────
  function validateStep() {
    let valid = false;

    switch (state.currentStep) {
      case 1:
        valid = state.selectedCategory !== null;
        break;
      case 2:
        valid = state.selectedPackage !== null;
        break;
      case 3: {
        const validSizes = validSizesForPackage(state.selectedCategory, state.selectedPackage);
        valid = validSizes.length > 1 ? state.selectedSize !== null : true;
        break;
      }
      case 4:
        valid = scheduleValid();
        break;
      case 5:
        valid = state.policiesAccepted === true;
        break;
    }

    btnNext.disabled = !valid || state.submitting || state.completed;
    if (!state.completed) saveState();
  }

  function updateStepUI() {
    const stepsEls = ['ws1', 'ws2', 'ws3', 'ws4', 'ws5'].map(id => document.getElementById(id));
    stepsEls.forEach((el, index) => {
      if (el) el.classList.toggle('active', index === state.currentStep - 1);
    });

    stepCircles.forEach((circle, i) => {
      const stepNum = i + 1;
      circle.classList.remove('active', 'done');
      if (stepNum < state.currentStep) {
        circle.classList.add('done');
        circle.innerHTML = CHECK_SVG;
      } else if (stepNum === state.currentStep) {
        circle.classList.add('active');
        circle.innerHTML = stepNum;
      } else {
        circle.innerHTML = stepNum;
      }
    });

    stepLines.forEach((line, i) => {
      line.classList.toggle('done', (i + 1) < state.currentStep);
    });

    btnBack.style.display = state.currentStep > 1 ? 'inline-flex' : 'none';

    const addBtn = document.getElementById('btnAddLine');
    if (addBtn) {
      // Committing the draft adds one more line; block when that would exceed the cap.
      const atCap = state.cart.length + 1 >= CART_MAX_ITEMS;
      addBtn.disabled = atCap;
      const hint = document.getElementById('addLineHint');
      if (hint) hint.hidden = !atCap;
    }

    if (state.currentStep === state.totalSteps) {
      const buttonLabel = state.completed ? t('btn.booked') : (state.submitting ? t('btn.saving') : (state.submitError ? t('btn.retry') : t('btn.book')));
      btnNext.innerHTML = `
        ${buttonLabel}
        <svg viewBox="0 0 24 24" fill="currentColor" class="btn-icon" width="18" height="18">
          <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
        </svg>
      `;
    } else {
      btnNext.innerHTML = `
        ${state.currentStep === 4 ? t('btn.review') : t('btn.next')}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="btn-icon">
          <path d="M5 12h14"/><path d="M12 5l7 7-7 7"/>
        </svg>
      `;
    }

    validateStep();
  }

  function goToStep(step) {
    state.currentStep = step;
    if (step !== state.totalSteps) {
      if (state.completed) {
        state.completed = false;
        state.confirmedBooking = null;
        state.submissionId = newSubmissionId();
      }
      state.submitError = false;
      setSubmissionStatus('', '');
    }

    if (step === 2) renderPackages();
    else if (step === 3) renderSizesAndAddons();
    else if (step === 4) {
      restoreScheduleInputs();
      loadAvailability();
    }
    else if (step === 5) renderSummary();

    updateStepUI();
    updateQuoteBar();
    document.getElementById('quoter').scrollIntoView({ behavior: 'smooth' });
  }

  btnNext.addEventListener('click', async () => {
    if (btnNext.disabled) return;

    if (state.currentStep === state.totalSteps) {
      await submitQuoteAndContinue();
      return;
    }

    // Leaving step 3 commits the draft as a cart line; step 4 works on the cart.
    if (state.currentStep === 3 && !commitDraftToCart()) return;
    goToStep(state.currentStep + 1);
  });

  btnBack.addEventListener('click', () => {
    if (state.currentStep === 4 && state.cart.length) {
      // Reopen the last committed line as the draft so "back" feels natural.
      editCartLine(state.cart[state.cart.length - 1].lineId, 3);
      return;
    }
    if (state.currentStep > 1) {
      goToStep(state.currentStep - 1);
    }
  });

  // ──────────────────────────────────────────────
  // CRM SUBMISSION + WHATSAPP DISPATCH
  // ──────────────────────────────────────────────
  function setSubmissionStatus(message, type) {
    const statusEl = document.getElementById('submissionStatus');
    if (statusEl) {
      statusEl.textContent = message || '';
      statusEl.className = 'submission-status' + (type ? ` ${type}` : '');
    }
    const continueBtn = document.getElementById('continueWhatsApp');
    if (continueBtn) continueBtn.hidden = type !== 'error' && type !== 'success';
    renderDepositCta(type);
  }

  // Phase B: the success response may include a hosted GHL payment link for
  // the deposit (only when GHL_DEPOSIT_PAYMENTS=on server-side). Shown as a
  // prominent CTA on the success screen; absent entirely otherwise, leaving
  // the success screen unchanged from Phase A.
  function renderDepositCta(type) {
    const depositEl = document.getElementById('depositCta');
    if (!depositEl) return;
    const depositUrl = type === 'success' && state.confirmedBooking ? state.confirmedBooking.depositUrl : '';
    if (!depositUrl) {
      depositEl.hidden = true;
      depositEl.removeAttribute('href');
      depositEl.innerHTML = '';
      return;
    }
    const amount = state.availability.deposit || 0;
    depositEl.href = depositUrl;
    depositEl.innerHTML = `${escapeHTML(t('submit.depositCta').replace('{amount}', String(amount)))}<span class="deposit-cta-hint">${escapeHTML(t('submit.depositHint'))}</span>`;
    depositEl.hidden = false;
  }

  function buildWhatsAppUrl() {
    if (!state.policiesAccepted) return;
    const entries = state.cart
      .map(line => ({ line, resolved: resolveLine(line), est: lineEstimate(line) }))
      .filter(entry => entry.resolved);
    if (!entries.length) return;
    const s = state.schedule;
    const total = cartEstimate();
    const many = entries.length > 1;

    // compact=true drops per-line add-on/vehicle detail to fit WhatsApp's URL limit.
    const build = (compact) => {
      let message = `*${t('wa.title')}*\n\n`;
      entries.forEach(({ line, resolved, est }, index) => {
        const { cat, pkg, size, addons } = resolved;
        const label = many ? t('wa.serviceN').replace('{n}', String(index + 1)) : t('wa.service');
        message += `*${label}:* ${pkg.name}`;
        if (validSizesForPackage(cat, pkg).length > 1) message += ` (${size.name})`;
        if (est) message += ` — ${est.label}`;
        message += '\n';
        if (compact) return;
        if (addons.length) {
          message += `  ${t('wa.addons')}: ${addons.map(a => `${a.name} (${addonWhatsAppPrice(a, pkg)})`).join(', ')}\n`;
        }
        const v = line.vehicle || blankVehicle();
        const vehicleText = [v.year, v.make, v.model, v.color].filter(Boolean).join(' ');
        if (vehicleText) message += `  ${t('wa.vehicle')}: ${vehicleText}${v.plate ? ` (${v.plate})` : ''}\n`;
      });

      message += `\n*${t('wa.total')}:* ${total ? total.label : '—'}\n\n`;

      message += `*${t('wa.contact')}:* ${s.name || '—'}\n`;
      if (s.phone) message += `*${t('wa.phone')}:* ${normalizedPhone(s.phone)}\n`;
      if (s.email) message += `*${t('wa.email')}:* ${s.email.trim()}\n`;
      if (s.address) message += `*${t('wa.address')}:* ${s.address}${s.unit ? ', ' + s.unit : ''}\n`;
      if (s.city) message += `*${t('wa.city')}:* ${s.city}\n`;
      if (s.zip) message += `*${t('wa.area')}:* ${s.zip}\n`;
      if (s.date) message += `*${t('wa.date')}:* ${prettyDate(s.date)}\n`;
      if (s.timeWindow) message += `*${t('wa.time')}:* ${timeWindowLabel(s.timeWindow)}\n`;
      if (s.notes) message += `*${t('wa.notes')}:* ${s.notes}\n`;
      if (state.confirmedBooking && state.confirmedBooking.appointmentId) {
        message += `*Reservation #:* ${state.confirmedBooking.appointmentId}\n`;
      }
      message += `\n${t('wa.closing')}`;
      return message;
    };

    // Guard against WhatsApp's URL length limit: full → compact → without notes.
    let message = build(false);
    let encoded = encodeURIComponent(message);
    if (encoded.length > 1900) {
      message = build(true);
      encoded = encodeURIComponent(message);
    }
    if (encoded.length > 1900 && s.notes) {
      message = message.replace(`*${t('wa.notes')}:* ${s.notes}\n`, '');
      encoded = encodeURIComponent(message);
    }
    return `https://wa.me/${PHONE_E164}?text=${encoded}`;
  }

  function openWhatsApp(url, pendingWindow) {
    if (pendingWindow && !pendingWindow.closed) {
      pendingWindow.location.href = url;
      return;
    }
    const opened = window.open(url, '_blank');
    if (!opened) window.location.href = url;
  }

  function quotePayload() {
    const s = state.schedule;
    const items = state.cart
      .map(line => ({ line, resolved: resolveLine(line), est: lineEstimate(line) }))
      .filter(entry => entry.resolved)
      .map(({ line, resolved, est }) => {
        const { cat, pkg, size, addons } = resolved;
        const v = line.vehicle || blankVehicle();
        return {
          category: { id: cat.id, name: cat.name },
          package: { id: pkg.id, name: pkg.name },
          size: { id: size.id, name: size.name },
          addons: addons.map(addon => ({ id: addon.id, name: addon.name, price: addonWhatsAppPrice(addon, pkg) })),
          vehicle: {
            make: String(v.make || '').trim(),
            model: String(v.model || '').trim(),
            year: Number(v.year),
            color: String(v.color || '').trim(),
            plate: String(v.plate || '').trim()
          },
          estimate: est ? { min: est.min, max: est.max, label: est.label, custom: est.custom, isRange: est.isRange } : null
        };
      });
    const total = cartEstimate();
    return {
      submissionId: state.submissionId,
      language: LANG,
      website: s.website || '',
      policyAccepted: state.policiesAccepted,
      policyAcceptedAt: new Date().toISOString(),
      customer: {
        name: s.name.trim(),
        phone: normalizedPhone(s.phone),
        email: s.email.trim(),
        address: s.address.trim(),
        unit: s.unit.trim(),
        city: s.city.trim(),
        zip: s.zip.trim()
      },
      items,
      estimate: total ? { min: total.min, max: total.max, label: total.label, custom: total.custom, isRange: total.isRange } : null,
      schedule: { date: s.date, timeWindow: s.timeWindow, timeLabel: timeWindowLabel(s.timeWindow), notes: s.notes.trim() }
    };
  }

  async function submitQuoteAndContinue() {
    if (!state.policiesAccepted || state.submitting) return;
    state.submitting = true;
    state.submitError = false;
    setSubmissionStatus(t('submit.saving'), 'saving');
    updateStepUI();

    try {
      const response = await fetch('/api/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(quotePayload())
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) {
        const requestError = new Error(result.error || `CRM request failed (${response.status})`);
        requestError.status = response.status;
        throw requestError;
      }

      state.confirmedBooking = result;
      setSubmissionStatus(`${t('submit.success')} ${result.appointmentId}`, 'success');
      try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* storage unavailable */ }
      state.completed = true;
    } catch (error) {
      if (error.status === 409) {
        state.submitError = false;
        state.schedule.date = '';
        state.schedule.timeWindow = '';
        await loadAvailability(true);
        goToStep(4);
        const messageEl = document.getElementById('availabilityMessage');
        if (messageEl) {
          messageEl.textContent = t('submit.slotTaken');
          messageEl.className = 'availability-msg error';
        }
        return;
      }
      state.submitError = true;
      setSubmissionStatus(t('submit.error'), 'error');
    } finally {
      state.submitting = false;
      updateStepUI();
    }
  }

  const continueWhatsApp = document.getElementById('continueWhatsApp');
  if (continueWhatsApp) continueWhatsApp.addEventListener('click', () => openWhatsApp(buildWhatsAppUrl(), null));

  // ──────────────────────────────────────────────
  // ROUTE CARDS (Landing Page → wizard step 1)
  // The landing is marketing only: each card's single CTA opens the wizard
  // with its cluster filter applied. The wizard is the only selection surface.
  // ──────────────────────────────────────────────
  function setupRouteCards() {
    document.querySelectorAll('.build-route-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const route = SERVICE_ROUTES[btn.dataset.route];
        if (!route) return;
        state.catFilter = route.filter;
        clearServiceSelection();
        renderCatFilter();
        renderCategories();
        goToStep(1);
      });
    });
  }

  // ──────────────────────────────────────────────
  // PREMIUM MICRO-INTERACTIONS
  // ──────────────────────────────────────────────
  // Cursor spotlight — feeds --mx/--my CSS vars to a card
  function attachSpotlight(el) {
    if (prefersReduced || el.dataset.spot) return;
    el.dataset.spot = '1';
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100) + '%');
      el.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100) + '%');
    });
  }

  function setupReset() {
    const btn = document.getElementById('btnReset');
    if (!btn) return;
    btn.addEventListener('click', () => {
      try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
      state.catFilter = 'all';
      state.pkgType = 'onetime';
      state.heavyGroup = null;
      state.selectedCategory = null;
      state.selectedPackage = null;
      state.selectedSize = null;
      state.selectedAddons = [];
      state.quizYes = [];
      state.quizPicks = [];
      state.quizOpen = false;
      state.cart = [];
      state.draftVehicle = blankVehicle();
      state.policiesAccepted = false;
      state.submitting = false;
      state.submitError = false;
      state.completed = false;
      state.confirmedBooking = null;
      state.availability = { cartKey: '', loading: false, error: '', bookingMode: '', durationMinutes: 0, deposit: 0, dates: [] };
      state.submissionId = newSubmissionId();
      state.schedule = blankSchedule();
      const policyEl = document.getElementById('policyAccept');
      if (policyEl) policyEl.checked = false;
      setSubmissionStatus('', '');
      renderCartPanel();
      renderCatFilter();
      renderCategories();
      restoreScheduleInputs();
      goToStep(1);
    });
  }

  // ──────────────────────────────────────────────
  // ANIMATED HERO BACKGROUND VIDEO
  // Orientation-aware (horizontal desktop / vertical mobile), reduced-motion safe.
  // Only the matching source is downloaded; CSS provides the non-image fallback.
  // ──────────────────────────────────────────────
  function setupHeroVideo() {
    const video = document.querySelector('.hero-bg-video');
    if (!video) return;
    video.removeAttribute('poster');

    // Evaluate the media queries live (not the load-time `prefersReduced`
    // constant, which can be stale) and react to changes.
    const reduceMq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const portraitMq = window.matchMedia('(max-width: 768px), (orientation: portrait)');
    let currentMode = null;

    function load(mode) {
      if (mode === currentMode) return;
      currentMode = mode;
      const src = mode === 'mobile' ? video.dataset.srcMobile : video.dataset.srcDesktop;
      if (!src) return;
      video.classList.remove('is-playing');
      video.muted = true;
      video.src = src;
      video.load();
      const p = video.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }

    const reveal = () => video.classList.add('is-playing');
    video.addEventListener('playing', reveal);
    video.addEventListener('canplay', reveal);

    function pick() {
      if (reduceMq.matches) {
        // Honor reduced motion with the CSS fallback only; no static hero photo.
        currentMode = null;
        video.classList.remove('is-playing');
        video.pause();
        video.removeAttribute('src');
        video.load();
        return;
      }
      load(portraitMq.matches ? 'mobile' : 'desktop');
    }
    pick();

    const onChange = () => pick();
    [reduceMq, portraitMq].forEach(mq => {
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    });

    // Pause when the hero scrolls out of view to save resources
    if ('IntersectionObserver' in window) {
      const hero = document.getElementById('hero');
      if (hero) {
        new IntersectionObserver((entries) => {
          entries.forEach(e => {
            if (reduceMq.matches) return;
            if (e.isIntersecting) { video.play().catch(() => {}); }
            else { video.pause(); }
          });
        }, { threshold: 0.05 }).observe(hero);
      }
    }
  }

  // ──────────────────────────────────────────────
  // LANGUAGE TOGGLE (ES / EN)
  // ──────────────────────────────────────────────
  function refreshAfterLang() {
    renderCatFilter();
    renderCategories();
    renderCartPanel();
    if (state.currentStep >= 2) renderPackages();
    if (state.currentStep >= 3) renderSizesAndAddons();
    if (state.currentStep === 5) renderSummary();
    restoreScheduleInputs();
    updateStepUI();
    updateQuoteBar();
  }

  function updateLangToggle() {
    const btn = document.getElementById('langToggle');
    if (!btn) return;
    const lbl = btn.querySelector('.lang-toggle-label');
    if (lbl) lbl.textContent = LANG === 'es' ? 'EN' : 'ES';
    btn.setAttribute('aria-label', LANG === 'es' ? 'Switch language to English' : 'Cambiar idioma a español');
  }

  function applyLanguage(lang, persist) {
    LANG = (lang === 'es') ? 'es' : 'en';
    if (persist) { try { localStorage.setItem('lyb-lang', LANG); } catch (e) { /* storage unavailable */ } }
    const root = document.documentElement;
    root.setAttribute('data-lang', LANG);
    root.setAttribute('lang', LANG);
    applyServiceLanguage(LANG);
    applyUILanguage();
    updateLangToggle();
    setupContactLinks();
    refreshAfterLang();
  }

  function setupLangToggle() {
    const btn = document.getElementById('langToggle');
    if (!btn) return;
    updateLangToggle();
    btn.addEventListener('click', () => applyLanguage(LANG === 'es' ? 'en' : 'es', true));
  }

  // ──────────────────────────────────────────────
  // INITIALIZATION
  // ──────────────────────────────────────────────
  function init() {
    setupThemeToggle();
    setupLangToggle();
    applyUILanguage();
    setupContactLinks();
    setupHeroVideo();
    handleNavScroll();
    restoreState();
    renderCatFilter();
    renderCategories();
    renderCartPanel();
    setupCart();
    setupSchedule();
    restoreScheduleInputs();
    setupReset();
    setupRouteCards();
    document.querySelectorAll('.route-card').forEach(attachSpotlight);
    updateStepUI();
    updateQuoteBar();
  }

  init();

})();
