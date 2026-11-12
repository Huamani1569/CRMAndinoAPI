// =====================================================================
// PRUEBAS DE LA API — Proyecto Final (Semanas 12 a 14)
// Recorre los flujos F1 a F4 de la ficha contra una base PostgreSQL de prueba:
//   1. parte de la base del PARCIAL (schema.sql + seed.sql)
//   2. la API aplica sola las migraciones 001–004 y entrena los modelos de ML
//   3. se prueban los endpoints como lo harían las tres apps
// Uso: DATABASE_URL_PRUEBAS=postgres://... npm test   (¡usa una base vacía o de pruebas, nunca la de Neon!)
// =====================================================================
const { Pool } = require('pg');
const crypto = require('crypto');
const db = require('../src/db');

const URL = process.env.DATABASE_URL_PRUEBAS;
process.env.GOOGLE_TOKENS_DE_PRUEBA = '1';   // tokens de Google simulados solo en las pruebas
if (!URL) { console.error('Define DATABASE_URL_PRUEBAS con una base de PRUEBAS.'); process.exit(1); }
db.usarPool(new Pool({ connectionString: URL }));
const { aplicarMigraciones } = require('../src/migraciones');
const { entrenarTodo } = require('../src/ml');
const { crearApp } = require('../src/app');

let base, ok = 0, fallas = 0;
const uuid = () => crypto.randomUUID();
const log = (b, t) => { if (b) { ok++; console.log('  ✔ ' + t); } else { fallas++; console.log('  ✖ ' + t); } };

async function api(metodo, ruta, { token, body, op = true, headers = {} } = {}) {
    const h = { ...headers };
    if (token) h.Authorization = 'Bearer ' + token;
    if (body !== undefined && !(body instanceof Buffer)) h['Content-Type'] = 'application/json';
    if (op && metodo !== 'GET') h['X-Operacion-UUID'] = typeof op === 'string' ? op : uuid();
    const r = await fetch(base + ruta, { method: metodo, headers: h, body: body === undefined ? undefined : (body instanceof Buffer ? body : JSON.stringify(body)) });
    const tipo = r.headers.get('content-type') || '';
    return { status: r.status, body: tipo.includes('json') ? await r.json() : await r.arrayBuffer(), headers: r.headers };
}
const login = async (correo, clave, app) => (await api('POST', '/api/auth/login', { body: { correo, clave, app }, op: false })).body.token;

(async () => {
    console.log('Preparando base de prueba (migraciones + ML)...');
    const m = await aplicarMigraciones({ log: () => {} });
    const ml = await entrenarTodo();
    console.log(`  migraciones: ${m.join(', ') || 'ninguna'} · lead scoring AUC ${ml.leadScoring.auc} · churn AUC ${ml.churn.auc} · ${ml.apriori.reglas} reglas`);
    const srv = crearApp().listen(0);
    base = `http://127.0.0.1:${srv.address().port}`;

    console.log('\nAcceso');
    log((await api('GET', '/api/salud')).status === 200, 'Salud de la API');
    const legado = await api('POST', '/api/auth/login', { body: { correo: 'carlos@crmandino.pe', clave: 'vendedor123', rolEsperado: 'cliente' }, op: false });
    log(legado.status === 200 && legado.body.usuario.rol === 'cliente', 'Las apps del parcial siguen entrando (rol legado "cliente" = vendedor)');
    const VEN = await login('carlos@crmandino.pe', 'vendedor123', 'VENDEDOR');
    const SUP = await login('supervisor@crmandino.pe', 'super123', 'SUPERVISOR');
    const AGS = await login('sofia@crmandino.pe', 'agente123', 'SUPERVISOR');
    const AGM = await login('marco@crmandino.pe', 'agente123', 'SUPERVISOR');
    const CLI = await login('rosa@ferreteriaeltambo.pe', 'cliente123', 'PORTAL');
    log(VEN && SUP && AGS && AGM && CLI, 'Login de vendedor, supervisor, agentes y cliente en su app');
    log((await api('POST', '/api/auth/login', { body: { correo: 'carlos@crmandino.pe', clave: 'vendedor123', app: 'PORTAL' }, op: false })).status === 403,
        'Un vendedor no puede entrar al Portal (403)');
    log((await api('GET', '/api/leads', { token: CLI })).status === 403, 'Un cliente no puede ver la cartera de leads (403)');

    console.log('\nPortal · registro (HU-P01)');
    const reg = { ruc: '20577778881', razonSocial: 'Bodega La Esperanza SAC', contacto: 'Mario Ccanto', telefono: '987654321', correo: 'mario@laesperanza.pe', clave: 'esperanza2026', aceptaTratamientoDatos: true };
    let r = await api('POST', '/api/portal/registro', { body: reg, op: false });
    log(r.status === 201 && r.body.token && r.body.vinculadoAClienteExistente === false, 'Registro de un prospecto nuevo con RUC');
    const NUEVO = r.body.token;
    log((await api('POST', '/api/portal/registro', { body: reg, op: false })).status === 409, 'Correo repetido → 409');
    r = await api('POST', '/api/portal/registro', { body: { ...reg, correo: 'compras@ferreteriaeltambo.pe', ruc: '20612345671' }, op: false });
    log(r.status === 201 && r.body.vinculadoAClienteExistente === true, 'RUC existente → se vincula al cliente (RF-P02)');
    log((await api('POST', '/api/portal/registro', { body: { ...reg, correo: 'x@y.pe', ruc: '123' }, op: false })).body.error === 'RUC_INVALIDO', 'RUC inválido → 422');
    log((await api('POST', '/api/portal/registro', { body: { ...reg, correo: 'x@y.pe', aceptaTratamientoDatos: false }, op: false })).body.error === 'CONSENTIMIENTO_REQUERIDO',
        'Sin consentimiento no hay registro (Ley 29733)');

    console.log('\nF1 · Del Portal a la venta');
    const prods = (await api('GET', '/api/productos', { token: CLI })).body.datos;
    const FAC = prods.find(p => p.codigo === 'FAC-01'), CAP = prods.find(p => p.codigo === 'CAP-01');
    const solUuid = uuid(), opSol = uuid();
    r = await api('POST', '/api/portal/solicitudes-cotizacion', { token: CLI, op: opSol, body: { uuid: solUuid, productos: [{ productoId: FAC.id, cantidad: 5 }], comentario: 'Necesitamos empezar en noviembre' } });
    log(r.status === 201 && /^SOL-\d{4}-\d{4}$/.test(r.body.dato.codigo) && r.body.dato.estado === 'RECIBIDA', `Solicitud de cotización → ${r.body.dato?.codigo} RECIBIDA`);
    const sol = r.body.dato;
    r = await api('POST', '/api/portal/solicitudes-cotizacion', { token: CLI, op: opSol, body: { uuid: solUuid, productos: [{ productoId: FAC.id, cantidad: 5 }] } });
    log(r.headers.get('x-operacion-duplicada') === 'true', 'Reenvío con el mismo X-Operacion-UUID → no se repite');
    r = await api('POST', '/api/portal/solicitudes-cotizacion', { token: CLI, body: { uuid: solUuid, productos: [{ productoId: FAC.id, cantidad: 5 }] } });
    log(r.status === 200 && r.body.dato.codigo === sol.codigo, 'Reenvío offline con el mismo uuid → misma solicitud, sin duplicar');
    let notis = (await api('GET', '/api/notificaciones', { token: VEN })).body;
    log(notis.datos.some(n => n.tipo === 'LEAD_PORTAL' && n.cuerpo.includes(sol.codigo)), 'El vendedor recibe la notificación del lead del Portal');
    const leadP = (await api('GET', `/api/leads/${sol.id}`, { token: VEN })).body.dato;
    log(leadP.canalOrigen === 'PORTAL' && leadP.etapa === 'NUEVO' && Number.isInteger(leadP.puntaje), `El lead aparece en la App Vendedor con puntaje ML-01 = ${leadP.puntaje}`);
    log(leadP.productosSolicitados.length === 1, 'El vendedor ve qué productos pidió el cliente');
    r = await api('GET', '/api/leads?orden=puntaje', { token: VEN });
    const p = r.body.datos.map(x => x.puntaje ?? -1);
    log(p.every((v, i) => i === 0 || p[i - 1] >= v), 'La cartera viene ordenada por puntaje (RF-V01)');
    r = await api('GET', '/api/leads?etapa=NUEVO&canal=PORTAL&puntajeMin=0', { token: VEN });
    log(r.body.datos.every(x => x.etapa === 'NUEVO' && x.canalOrigen === 'PORTAL'), 'Filtros combinables por etapa, canal y puntaje (RF-V02)');

    r = await api('POST', '/api/interacciones', { token: VEN, body: { uuid: uuid(), leadUuid: leadP.uuid, tipo: 'WhatsApp', resultado: 'INTERESADO' } });
    log(r.status === 201 && r.body.dato.fechaHora, 'Interacción por WhatsApp con fecha y hora automáticas (RF-V06)');
    log((await api('POST', '/api/interacciones', { token: VEN, body: { uuid: uuid(), leadUuid: leadP.uuid, tipo: 'Reunión' } })).body.error === 'NOTA_OBLIGATORIA',
        'Reunión sin nota → 422');
    r = await api('PUT', `/api/leads/${leadP.id}/etapa`, { token: VEN, body: { etapa: 'CONTACTADO' } });
    log(r.status === 200 && r.body.dato.etapa === 'CONTACTADO', 'Etapa NUEVO → CONTACTADO');
    r = await api('PUT', `/api/leads/${leadP.id}/etapa`, { token: VEN, body: { etapa: 'NUEVO' } });
    log(r.status === 422, 'El embudo no retrocede (CONTACTADO → NUEVO = 422)');

    r = await api('POST', '/api/cotizaciones', { token: VEN, body: { uuid: uuid(), leadId: leadP.id, descuentoPct: 8, items: [{ productoId: FAC.id, cantidad: 5 }, { productoId: CAP.id, cantidad: 2 }], enviar: true } });
    const cot = r.body.dato;
    log(r.status === 201 && cot.estado === 'ENVIADA' && cot.total === Math.round((5 * FAC.precio + 2 * CAP.precio) * 0.92 * 100) / 100 && /^COT-\d{4}-\d{4}$/.test(cot.numero),
        `Cotización ${cot?.numero} enviada: total S/ ${cot?.total} = Σ(precio × cantidad) × (1 − 8 %)`);
    log((await api('GET', `/api/leads/${leadP.id}`, { token: VEN })).body.dato.etapa === 'COTIZADO', 'El lead pasó a COTIZADO (RF-V10)');
    r = await api('GET', '/api/cotizaciones', { token: CLI });
    log(r.body.datos.some(c => c.id === cot.id && c.diasParaVencer === 15), 'El cliente ve la cotización en su Portal, con 15 días de vigencia');
    r = await api('PUT', `/api/cotizaciones/${cot.id}/respuesta`, { token: CLI, body: { decision: 'ACEPTAR' } });
    log(r.status === 200 && r.body.dato.estado === 'ACEPTADA', 'El cliente acepta la cotización');
    log((await api('GET', `/api/leads/${leadP.id}`, { token: VEN })).body.dato.etapa === 'GANADO', 'El lead pasó a GANADO');
    notis = (await api('GET', '/api/notificaciones', { token: VEN })).body;
    log(notis.datos.some(n => n.tipo === 'COTIZACION_ACEPTADA'), 'El vendedor recibe "Cotización aceptada"');
    log((await api('PUT', `/api/cotizaciones/${cot.id}/respuesta`, { token: CLI, body: { decision: 'ACEPTAR' } })).status === 409, 'No se acepta dos veces (409)');
    log((await api('PUT', `/api/leads/${leadP.id}/etapa`, { token: VEN, body: { etapa: 'PERDIDO', motivoPerdida: 'x' } })).status === 422, 'Un lead GANADO ya no cambia de etapa');
    const hist = (await api('GET', `/api/leads/${leadP.id}/historial`, { token: VEN })).body.datos;
    log(hist.filter(h => h.campo === 'ETAPA').length >= 3, `El historial guardó ${hist.filter(h => h.campo === 'ETAPA').length} cambios de etapa (RNF-09)`);

    console.log('\nRN-03 · Descuento mayor a 10 %');
    r = await api('POST', '/api/leads', { token: VEN, body: { uuid: uuid(), empresa: 'Ferretería El Tambo SAC', contacto: 'Rosa Quispe', ruc: '20612345671', valorPotencial: 9000, telefono: '964123456' } });
    const lead2 = r.body.dato;
    log(r.status === 201 && lead2.canalOrigen === 'VENDEDOR' && lead2.puntaje != null, 'Lead creado por el vendedor (canal VENDEDOR) con puntaje inmediato');
    log((await api('POST', '/api/leads', { token: VEN, body: { uuid: uuid(), empresa: 'X', contacto: '' } })).body.error === 'CONTACTO_OBLIGATORIO', 'Lead sin contacto → 422 (RF-V04)');
    await api('PUT', `/api/leads/${lead2.id}/etapa`, { token: VEN, body: { etapa: 'CALIFICADO' } });
    r = await api('POST', '/api/cotizaciones', { token: VEN, body: { uuid: uuid(), leadId: lead2.id, descuentoPct: 15, items: [{ productoId: FAC.id, cantidad: 3 }], enviar: true } });
    const cot2 = r.body.dato;
    log(cot2.estado === 'PEND_APROBACION', 'Descuento de 15 % queda PENDIENTE de aprobación');
    log(!(await api('GET', '/api/cotizaciones', { token: CLI })).body.datos.some(c => c.id === cot2.id), 'El cliente no la ve mientras está pendiente');
    log((await api('GET', '/api/cotizaciones?estado=PEND_APROBACION', { token: SUP })).body.datos.some(c => c.id === cot2.id), 'El supervisor la ve en su bandeja de aprobación');
    r = await api('PUT', `/api/cotizaciones/${cot2.id}/aprobacion`, { token: SUP, body: { aprobar: true } });
    log(r.body.dato?.estado === 'ENVIADA' && r.body.dato.aprobadaPor, 'El supervisor aprueba y se envía');
    log((await api('PUT', `/api/cotizaciones/${cot2.id}/respuesta`, { token: CLI, body: { decision: 'RECHAZAR' } })).body.error === 'MOTIVO_OBLIGATORIO', 'Rechazar sin motivo → 422');
    r = await api('PUT', `/api/cotizaciones/${cot2.id}/respuesta`, { token: CLI, body: { decision: 'RECHAZAR', motivo: 'PRECIO', comentario: 'Muy caro' } });
    log(r.body.dato?.estado === 'RECHAZADA' && r.body.dato.motivoRechazo === 'PRECIO', 'Rechazada por precio');
    log((await api('GET', `/api/leads/${lead2.id}`, { token: VEN })).body.dato.etapa === 'CALIFICADO', 'El lead vuelve a CALIFICADO para recotizar');

    console.log('\nF2 · Visita en campo (HU-V04)');
    r = await api('GET', '/api/visitas/ruta', { token: VEN });
    log(r.status === 200 && r.body.total > 0, `Ruta del día: ${r.body.total} clientes ${r.body.sugerida ? '(sugeridos por puntaje)' : ''}`);
    const parada = r.body.datos[0];
    const lejos = { latitud: parada.latitudCliente + 0.005, longitud: parada.longitudCliente, precisionM: 10, fechaHora: new Date().toISOString() };
    r = await api('POST', '/api/visitas', { token: VEN, body: { uuid: uuid(), leadUuid: parada.leadUuid, checkin: lejos } });
    log(r.status === 422 && r.body.error === 'MOTIVO_DISTANCIA_REQUERIDO' && r.body.distanciaM > 300, `Check-in a ${Math.round(r.body.distanciaM)} m sin motivo → 422 (RF-V13)`);
    r = await api('POST', '/api/visitas', { token: VEN, body: { uuid: uuid(), leadUuid: parada.leadUuid, checkin: lejos, motivoDistancia: 'El cliente me citó en su otra tienda' } });
    log(r.status === 201 && r.body.dato.distanciaM > 300 && r.body.dato.motivoDistancia, 'Con motivo se registra y guarda la distancia');
    const cerca = { latitud: parada.latitudCliente + 0.0002, longitud: parada.longitudCliente, precisionM: 8 };
    const vUuid = uuid();
    r = await api('POST', '/api/visitas', { token: VEN, body: { uuid: vUuid, leadUuid: parada.leadUuid, checkin: cerca } });
    log(r.status === 201 && r.body.dato.distanciaM < 50, `Check-in a ${r.body.dato?.distanciaM} m del cliente`);
    r = await api('POST', '/api/visitas', { token: VEN, body: { uuid: vUuid, leadUuid: parada.leadUuid, checkin: cerca } });
    log(r.status === 200, 'Check-in offline reenviado → no se duplica');
    log((await api('GET', `/api/interacciones?leadId=${parada.leadId}`, { token: VEN })).body.datos.some(i => i.tipo === 'Visita'), 'La visita queda como interacción del lead');

    console.log('\nF3 · Proceso de lealtad (HU-P04, HU-S03)');
    await db.query("UPDATE clientes SET puntaje_valor = 84 WHERE ruc = '20612345671'");
    log((await api('POST', '/api/servicio/solicitudes', { token: CLI, body: { uuid: uuid(), categoria: 'FACTURACION', descripcion: 'No funciona' } })).body.error === 'DESCRIPCION_CORTA',
        'Descripción menor a 20 caracteres → 422');
    r = await api('POST', '/api/servicio/solicitudes', { token: CLI, body: { uuid: uuid(), categoria: 'FACTURACION', descripcion: 'No se envían las boletas a SUNAT desde ayer en la tarde' } });
    const t = r.body.dato;
    log(r.status === 201 && t.prioridad === 'ALTA' && t.agenteNombre === 'Sofía Rojas Meza' && t.puntajeCliente === undefined,
        `Cliente con puntaje 84 → ${t?.numero} prioridad ALTA, agente senior ${t?.agenteNombre}; el cliente no ve su puntaje`);
    log(Math.round((new Date(t.slaHasta) - new Date(t.creadoEn)) / 3600000) === 4, 'SLA de 4 horas (RN-06)');
    r = await api('POST', '/api/servicio/solicitudes', { token: NUEVO, body: { uuid: uuid(), categoria: 'ACCESO', descripcion: 'No puedo entrar al sistema con mi clave nueva' } });
    log(r.body.dato?.prioridad === 'NORMAL' && r.body.dato.agenteId === null, 'Cliente sin información → cola general, prioridad NORMAL');
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
    r = await api('POST', `/api/servicio/solicitudes/${t.id}/foto`, { token: CLI, body: png, op: false, headers: { 'Content-Type': 'image/png' } });
    log(r.status === 200 && r.body.bytes === png.length, 'Foto adjunta al ticket (RF-P07)');
    log((await api('GET', `/api/servicio/solicitudes/${t.id}/foto`, { token: AGS })).status === 200, 'El agente ve la foto');
    r = await api('GET', '/api/servicio/solicitudes', { token: AGS });
    const cola = r.body.datos.filter(x => ['ABIERTA', 'EN_ATENCION'].includes(x.estado));
    log(cola.length > 0 && cola.every((x, i) => i === 0 || !(x.prioridad === 'ALTA' && cola[i - 1].prioridad === 'NORMAL')), 'Cola del agente: primero prioridad alta, luego antigüedad (RF-S04)');
    const det = (await api('GET', `/api/servicio/solicitudes/${t.id}`, { token: AGS })).body.dato;
    log(det.perfilCliente && det.perfilCliente.puntajeValor === 84 && det.perfilCliente.compras >= 1, 'El agente ve el perfil del cliente: puntaje, compras y tickets (RF-S05)');
    log((await api('PUT', `/api/servicio/solicitudes/${t.id}/estado`, { token: AGM, body: { estado: 'EN_ATENCION' } })).status === 409, 'Otro agente no puede tomar un ticket asignado (409)');
    log((await api('PUT', `/api/servicio/solicitudes/${t.id}/estado`, { token: AGS, body: { estado: 'EN_ATENCION' } })).body.dato?.estado === 'EN_ATENCION', 'Sofía toma el caso');
    log((await api('PUT', `/api/servicio/solicitudes/${t.id}/estado`, { token: AGS, body: { estado: 'RESUELTA' } })).body.error === 'SOLUCION_OBLIGATORIA', 'Resolver sin solución → 422');
    r = await api('PUT', `/api/servicio/solicitudes/${t.id}/estado`, { token: AGS, body: { estado: 'RESUELTA', solucion: 'Se renovó el certificado digital' } });
    log(r.body.dato?.estado === 'RESUELTA', 'Ticket resuelto');
    log((await api('GET', '/api/notificaciones', { token: CLI })).body.datos.some(n => n.tipo === 'TICKET_ESTADO'), 'El cliente recibe la notificación de cada cambio (RF-P09)');
    r = await api('POST', `/api/servicio/solicitudes/${t.id}/calificacion`, { token: CLI, body: { calificacion: 5, comentario: 'Rápido' } });
    log(r.status === 201 && r.body.dato.estado === 'CERRADA' && r.body.dato.calificacion === 5, 'El cliente califica con 5 y el ticket se cierra');
    log((await api('POST', `/api/servicio/solicitudes/${t.id}/calificacion`, { token: CLI, body: { calificacion: 3 } })).status === 409, 'Solo una calificación por ticket (RF-P12)');
    const hT = (await api('GET', `/api/servicio/solicitudes/${t.id}`, { token: CLI })).body.dato.historial;
    log(hT.length >= 4, `El ticket guarda ${hT.length} eventos de historial`);

    console.log('\nF4 · Campañas (HU-S04, HU-P05)');
    const seg = { sinProducto: 'INV-01', tieneProducto: 'FAC-01' };
    const prev = (await api('POST', '/api/campanas/previsualizar', { token: SUP, body: { segmento: seg }, op: false })).body;
    log(prev.clientes > 0, `El segmento tiene ${prev.clientes} clientes (excluye ${prev.excluidosSinOfertas} sin ofertas)`);
    const hoy = new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
    const fin = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
    const INV = prods.find(x => x.codigo === 'INV-01');
    r = await api('POST', '/api/campanas', { token: SUP, body: { nombre: 'Inventario −15 % noviembre', segmento: seg, oferta: 'Módulo Inventario con 15 % de descuento', productoId: INV.id, descuentoPct: 15, canales: ['PUSH', 'WHATSAPP', 'CORREO'], inicio: hoy, fin } });
    const camp = r.body.dato;
    log(r.status === 201 && camp.estado === 'BORRADOR' && camp.tamanoSegmento === prev.clientes, 'Campaña creada en borrador');
    log((await api('POST', '/api/campanas', { token: SUP, body: { nombre: 'X', oferta: 'Y', canales: ['FAX'], inicio: hoy, fin } })).body.error === 'CANALES_INVALIDOS', 'Canal inválido → 422');
    r = await api('POST', `/api/campanas/${camp.id}/envio`, { token: SUP });
    log(r.body.envios === prev.clientes * 3, `Enviada: ${r.body.clientes} clientes × 3 canales = ${r.body.envios} envíos`);
    const ofertas = (await api('GET', '/api/portal/ofertas', { token: CLI })).body.datos;
    log(ofertas.some(o => o.campanaId === camp.id), 'Rosa ve la oferta en su Portal');
    r = await api('POST', `/api/campanas/${camp.id}/respuesta`, { token: CLI, body: { canal: 'PUSH' } });
    log(r.status === 201 && r.body.leadId, '"Me interesa" crea un lead');
    const leadC = (await api('GET', `/api/leads/${r.body.leadId}`, { token: VEN })).body.dato;
    log(leadC.canalOrigen === 'CAMPANA', 'El lead tiene canal CAMPANA y lo ve el vendedor');
    const res2 = (await api('GET', `/api/campanas/${camp.id}/resultados`, { token: SUP })).body;
    log(res2.porCanal.find(x => x.canal === 'PUSH').respuestas === 1 && res2.dato.leadsGenerados === 1, 'Resultados por canal y conversión (RF-S08)');
    await api('PUT', '/api/portal/perfil', { token: CLI, body: { aceptaOfertas: false } });
    log((await api('GET', '/api/portal/ofertas', { token: CLI })).body.total === 0, 'Al desactivar ofertas ya no las ve (RN-07)');
    const prev2 = (await api('POST', '/api/campanas/previsualizar', { token: SUP, body: { segmento: seg }, op: false })).body;
    log(prev2.excluidosSinOfertas === prev.excluidosSinOfertas + 1, 'Y queda fuera de futuros segmentos');
    await api('PUT', '/api/portal/perfil', { token: CLI, body: { aceptaOfertas: true } });

    console.log('\nCRM analítica y ML (HU-S01, HU-S05, HU-V06)');
    const res = (await api('GET', '/api/analitica/resumen', { token: SUP })).body;
    log(res.pronostico.pronostico > 0 && res.kpis.csat > 0 && res.kpis.tasaConversion > 0, `Pronóstico S/ ${res.pronostico.pronostico} · conversión ${res.kpis.tasaConversion} % · CSAT ${res.kpis.csat} · cancelación ${res.kpis.tasaCancelacion} % · CLTV S/ ${res.kpis.cltvPromedio}`);
    const emb = (await api('GET', '/api/analitica/embudo', { token: SUP })).body.etapas;
    log(emb.length === 6 && emb.some(e => e.cantidad > 0), 'Embudo por etapa (RF-S01)');
    const pr = (await api('GET', '/api/analitica/pronostico', { token: SUP })).body;
    log(pr.porVendedor.length === 4, 'Pronóstico por vendedor (RF-S02)');
    const vm = (await api('GET', '/api/analitica/ventas-mensuales', { token: SUP })).body.serie;
    log(vm.length === 8 && vm.slice(0, 7).some(x => x.real > 0), 'Serie de ventas reales de 8 meses');
    const riesgo = (await api('GET', '/api/analitica/clientes-riesgo?minimo=0.3', { token: SUP })).body;
    log(riesgo.total > 0 && riesgo.datos[0].factores.length > 0, `${riesgo.total} clientes en riesgo con CLTV y factores (RF-S09, RF-S10)`);
    const rent = (await api('GET', '/api/analitica/clientes-rentables', { token: SUP })).body;
    log(rent.top.length === 10 && rent.segmentos.length > 0, 'Top 10 de clientes rentables y segmentos (RF-S12)');
    log((await api('GET', '/api/analitica/servicio', { token: SUP })).body.sla.length === 2, 'SLA y mapa de calor de solicitudes');
    log((await api('GET', '/api/analitica/modelos', { token: SUP })).body.datos.length === 4, 'Los 4 modelos de ML con sus métricas');
    log((await api('GET', '/api/analitica/resumen', { token: VEN })).status === 403, 'Un vendedor no ve la analítica (403)');

    const cRiesgo = riesgo.datos[0];
    r = await api('POST', '/api/tareas', { token: SUP, body: { uuid: uuid(), clienteId: cRiesgo.clienteId, vendedorId: cRiesgo.vendedorId, descripcion: 'Llamar para ofrecer soporte prioritario', fechaLimite: fin } });
    log(r.status === 201 && r.body.dato.tipo === 'RETENCION', `Tarea de retención para ${cRiesgo.razonSocial} (RF-S11)`);
    log((await api('POST', '/api/tareas', { token: SUP, body: { uuid: uuid(), clienteId: cRiesgo.clienteId, descripcion: 'x', fechaLimite: '2020-01-01' } })).body.error === 'FECHA_PASADA',
        'No se aceptan fechas pasadas (RF-V07)');

    const ficha = (await api('GET', `/api/clientes/${leadP.clienteId}`, { token: VEN })).body.dato;
    log(ficha.historialCompras.length >= 2, `Ficha del cliente con ${ficha.historialCompras.length} productos comprados (RF-V15)`);
    const rec = (await api('GET', `/api/ml/recomendaciones/${leadP.clienteId}`, { token: VEN })).body;
    log(rec.datos.length <= 3 && rec.datos.every(x => x.razon), `Recomendaciones de venta cruzada: ${rec.datos.map(x => x.producto).join(', ') || 'ninguna'} (RF-V16)`);

    console.log('\nGestión del supervisor (HU-S02)');
    const vends = (await api('GET', '/api/usuarios/vendedores', { token: SUP })).body.datos;
    const lucia = vends.find(v => v.nombre.startsWith('Lucía'));
    r = await api('PUT', '/api/leads/reasignar', { token: SUP, body: { leadIds: [lead2.id], vendedorDestinoId: lucia.id } });
    log(r.body.reasignados === 1, 'Reasignación en lote');
    const LUC = await login('lucia@crmandino.pe', 'vendedor123', 'VENDEDOR');
    log((await api('GET', '/api/notificaciones', { token: LUC })).body.datos.some(n => n.tipo === 'LEADS_REASIGNADOS'), 'La nueva vendedora recibe la notificación');
    log((await api('GET', `/api/leads/${lead2.id}`, { token: VEN })).status === 404, 'El vendedor original deja de verlo');
    log((await api('GET', `/api/leads/${lead2.id}/historial`, { token: SUP })).body.datos.some(h => h.campo === 'VENDEDOR'), 'La reasignación queda en el historial');
    r = await api('GET', '/api/sync/cambios?desde=' + new Date(Date.now() - 3600000).toISOString(), { token: VEN });
    log(r.body.cambios.leads > 0 && r.body.cambios.notificaciones > 0, 'Sincronización: la app sabe qué cambió desde la última vez');

    console.log('\nLogin con Google (API externa, Semana 15-16)');
    r = await api('POST', '/api/auth/google', { body: { idToken: 'prueba:rosa@ferreteriaeltambo.pe:Rosa', app: 'PORTAL' }, op: false });
    log(r.status === 200 && r.body.usuario.rol === 'cliente' && r.body.token, 'Una cuenta de Google con el correo de un cliente entra al Portal');
    r = await api('POST', '/api/auth/google', { body: { idToken: 'prueba:nuevo.cliente@gmail.com:Ana Quispe', app: 'PORTAL' }, op: false });
    log(r.status === 404 && r.body.error === 'SIN_CUENTA' && r.body.correo === 'nuevo.cliente@gmail.com', 'Una cuenta de Google nueva debe completar el registro (404 SIN_CUENTA con su correo)');
    r = await api('POST', '/api/portal/registro', { op: false, body: { ruc: '20588889991', razonSocial: 'Minimarket Ana EIRL', contacto: 'Ana Quispe', telefono: '912345678', correo: 'otro@x.pe', googleIdToken: 'prueba:nuevo.cliente@gmail.com:Ana Quispe', aceptaTratamientoDatos: true } });
    log(r.status === 201 && r.body.usuario.correo === 'nuevo.cliente@gmail.com', 'Registro con Google: usa el correo verificado y no exige contraseña');
    r = await api('POST', '/api/auth/google', { body: { idToken: 'prueba:nuevo.cliente@gmail.com:Ana Quispe', app: 'PORTAL' }, op: false });
    log(r.status === 200 && r.body.usuario.empresa === 'Minimarket Ana EIRL', 'Después del registro, Google inicia sesión directamente');
    r = await api('POST', '/api/auth/google', { body: { idToken: 'prueba:carlos@crmandino.pe:Carlos', app: 'PORTAL' }, op: false });
    log(r.status === 403, 'Un vendedor no entra al Portal con Google (403)');
    r = await api('POST', '/api/auth/google', { body: { idToken: 'token-falso' }, op: false });
    log(r.status === 401, 'Un token de Google falso se rechaza (401)');

    console.log(`\n${fallas ? '✖' : '✔'} ${ok} pruebas correctas, ${fallas} con error`);
    srv.close();
    await db.obtenerPool().end();
    process.exit(fallas ? 1 : 0);
})().catch(async (e) => { console.error(e); process.exit(1); });
