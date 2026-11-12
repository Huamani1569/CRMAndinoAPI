// CRM ANALÍTICA para la App Supervisor (HU-S01, HU-S05 · Semana 14)
//   GET  /api/analitica/resumen?mes=&vendedorId=   KPIs: pronóstico, conversión, resolución, CSAT, cancelación, CLTV
//   GET  /api/analitica/embudo?mes=&vendedorId=    cantidad y valor por etapa (RF-S01)
//   GET  /api/analitica/pronostico?mes=            pronóstico del mes y por vendedor (RF-S02)
//   GET  /api/analitica/ventas-mensuales           ventas reales y pronóstico (serie para el gráfico)
//   GET  /api/analitica/clientes-riesgo?minimo=    clientes por probabilidad de cancelación (RF-S09, RF-S10)
//   GET  /api/analitica/clientes-rentables         top 10 por margen y segmentos (RF-S12)
//   GET  /api/analitica/servicio                   solicitudes por día y hora, SLA y tiempos
//   GET  /api/analitica/modelos                    métricas de los modelos de ML
//   POST /api/ml/entrenar                          reentrena los 4 modelos (supervisor)
const express = require('express');
const { query } = require('../db');
const { permitirRoles } = require('../middleware/auth');
const { ROL_SUPERVISOR } = require('../errores');
const { entrenarTodo } = require('../ml');
const { num } = require('../servicios');

const router = express.Router();
router.use(permitirRoles(ROL_SUPERVISOR));

const mesActual = () => new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 7);
const mesValido = (m) => (typeof m === 'string' && /^\d{4}-\d{2}$/.test(m) ? m : mesActual());
const ETAPAS = ['NUEVO', 'CONTACTADO', 'CALIFICADO', 'COTIZADO', 'GANADO', 'PERDIDO'];

async function pronostico(mes, vendedorId = null) {
    const par = [mes + '-01'];
    const fv = vendedorId ? (par.push(vendedorId), `AND l.vendedor_id = $${par.length}`) : '';
    const r = await query(`
        WITH rango AS (SELECT $1::date AS ini, ($1::date + interval '1 month')::date AS fin)
        SELECT
          (SELECT COALESCE(sum(co.total), 0) FROM cotizaciones co JOIN leads l ON l.id = co.lead_id, rango
            WHERE co.estado = 'ACEPTADA' AND (co.respondida_en AT TIME ZONE 'America/Lima')::date >= rango.ini
              AND (co.respondida_en AT TIME ZONE 'America/Lima')::date < rango.fin ${fv})::float8 AS ganado,
          (SELECT COALESCE(sum(l.valor_potencial * COALESCE(l.puntaje, 30) / 100.0), 0) FROM leads l
            WHERE NOT l.eliminado AND l.etapa IN ('NUEVO','CONTACTADO','CALIFICADO','COTIZADO') ${fv})::float8 AS esperado,
          (SELECT monto FROM metas_ventas WHERE mes = to_char($1::date, 'YYYY-MM'))::float8 AS meta`, par);
    const f = r.rows[0];
    const esActual = mes === mesActual();
    return {
        mes, ganadoReal: Math.round(f.ganado), esperadoAbiertos: Math.round(f.esperado),
        pronostico: Math.round(f.ganado + (esActual || mes > mesActual() ? f.esperado : 0)),
        meta: f.meta ? Math.round(f.meta) : null,
        formula: 'ganado del mes + Σ (valor potencial × probabilidad de cierre ML-01) de los leads abiertos'
    };
}

router.get('/resumen', async (req, res, next) => {
    try {
        const mes = mesValido(req.query.mes);
        const vend = req.query.vendedorId ? Number(req.query.vendedorId) : null;
        const pr = await pronostico(mes, vend);
        const k = (await query(`
            SELECT
              (SELECT count(*) FILTER (WHERE etapa = 'GANADO')::float8 / NULLIF(count(*) FILTER (WHERE etapa IN ('GANADO','PERDIDO')), 0)
                 FROM leads WHERE NOT eliminado AND actualizado_en > now() - interval '180 days' ${vend ? 'AND vendedor_id = $1' : ''}) AS conversion,
              (SELECT avg(EXTRACT(EPOCH FROM resuelta_en - creado_en) / 3600) FROM solicitudes_servicio
                 WHERE resuelta_en > now() - interval '180 days')::float8 AS horas_resolucion,
              (SELECT avg(calificacion) FROM solicitudes_servicio WHERE calificada_en > now() - interval '180 days')::float8 AS csat,
              (SELECT count(*) FILTER (WHERE cancelado_en > CURRENT_DATE - 365)::float8 /
                      NULLIF(count(*) FILTER (WHERE fecha_alta <= CURRENT_DATE AND (cancelado_en IS NULL OR cancelado_en > CURRENT_DATE - 365)), 0)
                 FROM clientes WHERE EXISTS (SELECT 1 FROM leads l WHERE l.cliente_id = clientes.id AND l.etapa = 'GANADO')) AS cancelacion,
              (SELECT avg(cltv) FROM clientes WHERE cancelado_en IS NULL AND cltv IS NOT NULL)::float8 AS cltv,
              (SELECT count(*) FROM leads WHERE NOT eliminado AND etapa IN ('NUEVO','CONTACTADO','CALIFICADO','COTIZADO') ${vend ? 'AND vendedor_id = $1' : ''})::int AS abiertos,
              (SELECT count(*) FROM solicitudes_servicio WHERE estado IN ('ABIERTA','EN_ATENCION'))::int AS tickets_abiertos,
              (SELECT count(*) FROM cotizaciones WHERE estado = 'PEND_APROBACION')::int AS por_aprobar,
              (SELECT count(*) FROM clientes WHERE cancelado_en IS NULL AND prob_cancelacion >= 0.6)::int AS en_riesgo`,
            vend ? [vend] : [])).rows[0];
        res.json({
            mes, pronostico: pr,
            kpis: {
                tasaConversion: k.conversion == null ? null : Math.round(k.conversion * 1000) / 10,
                tiempoMedioResolucionH: k.horas_resolucion == null ? null : Math.round(k.horas_resolucion * 10) / 10,
                csat: k.csat == null ? null : Math.round(k.csat * 10) / 10,
                tasaCancelacion: k.cancelacion == null ? null : Math.round(k.cancelacion * 1000) / 10,
                cltvPromedio: k.cltv == null ? null : Math.round(k.cltv),
                leadsAbiertos: k.abiertos, ticketsAbiertos: k.tickets_abiertos,
                cotizacionesPorAprobar: k.por_aprobar, clientesEnRiesgo: k.en_riesgo
            }
        });
    } catch (e) { next(e); }
});

router.get('/embudo', async (req, res, next) => {
    try {
        const par = [];
        const cond = ['NOT l.eliminado'];
        if (req.query.mes) { par.push(mesValido(req.query.mes) + '-01'); cond.push(`l.creado_en >= $${par.length}::date AND l.creado_en < $${par.length}::date + interval '1 month'`); }
        if (req.query.vendedorId) { par.push(Number(req.query.vendedorId)); cond.push(`l.vendedor_id = $${par.length}`); }
        const r = await query(`SELECT etapa, count(*)::int AS cantidad, COALESCE(sum(valor_potencial), 0)::float8 AS valor
                               FROM leads l WHERE ${cond.join(' AND ')} GROUP BY etapa`, par);
        const mapa = new Map(r.rows.map(f => [f.etapa, f]));
        res.json({ mes: req.query.mes || null, etapas: ETAPAS.map(e => ({ etapa: e, cantidad: mapa.get(e)?.cantidad || 0, valor: Math.round(mapa.get(e)?.valor || 0) })) });
    } catch (e) { next(e); }
});

router.get('/pronostico', async (req, res, next) => {
    try {
        const mes = mesValido(req.query.mes);
        const total = await pronostico(mes);
        const vendedores = (await query("SELECT id, nombre FROM usuarios WHERE rol = 'vendedor' AND activo ORDER BY nombre")).rows;
        const porVendedor = [];
        for (const v of vendedores) porVendedor.push({ vendedorId: v.id, vendedor: v.nombre, ...(await pronostico(mes, v.id)) });
        res.json({ ...total, porVendedor });
    } catch (e) { next(e); }
});

router.get('/ventas-mensuales', async (req, res, next) => {
    try {
        const meses = Math.min(24, Math.max(3, Number(req.query.meses) || 8));
        const r = await query(`
            SELECT to_char(m, 'YYYY-MM') AS mes,
                   (SELECT COALESCE(sum(co.total), 0) FROM cotizaciones co WHERE co.estado = 'ACEPTADA'
                      AND co.respondida_en >= m AND co.respondida_en < m + interval '1 month')::float8 AS real
            FROM generate_series(date_trunc('month', now() AT TIME ZONE 'America/Lima') - make_interval(months => $1 - 1),
                                 date_trunc('month', now() AT TIME ZONE 'America/Lima'), interval '1 month') m`, [meses]);
        const serie = r.rows.map(f => ({ mes: f.mes, real: Math.round(f.real), pronostico: null }));
        const actual = await pronostico(mesActual());
        serie[serie.length - 1].pronostico = actual.pronostico;
        res.json({ serie, meta: actual.meta });
    } catch (e) { next(e); }
});

router.get('/clientes-riesgo', async (req, res, next) => {
    try {
        const minimo = Math.max(0, Math.min(1, Number(req.query.minimo ?? 0.5)));
        const r = await query(`
            SELECT c.id, c.razon_social, c.ruc, c.prob_cancelacion::float8 AS prob, c.cltv::float8 AS cltv, c.factores_riesgo,
                   c.puntaje_valor, c.vendedor_id, v.nombre AS vendedor,
                   (SELECT max(co.respondida_en) FROM cotizaciones co JOIN leads l ON l.id = co.lead_id WHERE l.cliente_id = c.id AND co.estado = 'ACEPTADA') AS ultima_compra,
                   EXISTS (SELECT 1 FROM tareas t JOIN leads l ON l.id = t.lead_id WHERE l.cliente_id = c.id AND t.tipo = 'RETENCION' AND NOT t.completada AND NOT t.eliminado) AS con_tarea
            FROM clientes c LEFT JOIN usuarios v ON v.id = c.vendedor_id
            WHERE c.cancelado_en IS NULL AND c.prob_cancelacion >= $1
            ORDER BY c.prob_cancelacion DESC, c.cltv DESC NULLS LAST LIMIT 100`, [minimo]);
        res.json({
            minimo, total: r.rowCount,
            datos: r.rows.map(f => ({
                clienteId: f.id, razonSocial: f.razon_social, ruc: f.ruc.trim(), probCancelacion: num(f.prob), cltv: num(f.cltv),
                factores: f.factores_riesgo || [], puntajeValor: f.puntaje_valor, vendedorId: f.vendedor_id, vendedor: f.vendedor,
                ultimaCompra: f.ultima_compra, tieneTareaRetencion: f.con_tarea
            }))
        });
    } catch (e) { next(e); }
});

router.get('/clientes-rentables', async (req, res, next) => {
    try {
        const margen = `
            SELECT l.cliente_id, sum(d.subtotal * (1 - co.descuento_pct / 100))::float8 AS ventas,
                   sum(d.subtotal * (1 - co.descuento_pct / 100) * p.margen_pct / 100)::float8 AS margen
            FROM cotizaciones co JOIN leads l ON l.id = co.lead_id JOIN cotizacion_detalle d ON d.cotizacion_id = co.id
            JOIN productos p ON p.id = d.producto_id WHERE co.estado = 'ACEPTADA' AND l.cliente_id IS NOT NULL GROUP BY l.cliente_id`;
        const top = await query(`SELECT c.id, c.razon_social, c.distrito, c.puntaje_valor, c.cltv::float8 AS cltv, m.ventas, m.margen
                                 FROM (${margen}) m JOIN clientes c ON c.id = m.cliente_id ORDER BY m.margen DESC LIMIT 10`);
        const seg = await query(`SELECT COALESCE(c.distrito, 'Sin distrito') AS segmento, count(*)::int AS clientes,
                                        sum(m.ventas)::float8 AS ventas, sum(m.margen)::float8 AS margen
                                 FROM (${margen}) m JOIN clientes c ON c.id = m.cliente_id WHERE c.cancelado_en IS NULL
                                 GROUP BY 1 ORDER BY margen DESC`);
        res.json({
            top: top.rows.map(f => ({ clienteId: f.id, razonSocial: f.razon_social, distrito: f.distrito, puntajeValor: f.puntaje_valor,
                cltv: num(f.cltv), ventas: Math.round(f.ventas), margen: Math.round(f.margen) })),
            segmentos: seg.rows.map(f => ({ segmento: f.segmento, clientes: f.clientes, ventas: Math.round(f.ventas), margen: Math.round(f.margen) }))
        });
    } catch (e) { next(e); }
});

router.get('/vendedores', async (req, res, next) => {
    try {
        const mes = mesValido(req.query.mes);
        const r = await query(`
            SELECT u.id, u.nombre,
                   COALESCE(sum(co.total) FILTER (WHERE co.estado = 'ACEPTADA' AND to_char(co.respondida_en AT TIME ZONE 'America/Lima', 'YYYY-MM') = $1), 0)::float8 AS ganado,
                   count(DISTINCT co.id) FILTER (WHERE co.estado = 'ACEPTADA' AND to_char(co.respondida_en AT TIME ZONE 'America/Lima', 'YYYY-MM') = $1)::int AS ventas
            FROM usuarios u LEFT JOIN cotizaciones co ON co.vendedor_id = u.id
            WHERE u.rol = 'vendedor' AND u.activo GROUP BY u.id ORDER BY ganado DESC`, [mes]);
        res.json({ mes, datos: r.rows.map(f => ({ vendedorId: f.id, vendedor: f.nombre, ganado: Math.round(f.ganado), ventas: f.ventas })) });
    } catch (e) { next(e); }
});

router.get('/servicio', async (req, res, next) => {
    try {
        const calor = await query(`
            SELECT EXTRACT(ISODOW FROM creado_en AT TIME ZONE 'America/Lima')::int AS dia, EXTRACT(HOUR FROM creado_en AT TIME ZONE 'America/Lima')::int AS hora, count(*)::int AS n
            FROM solicitudes_servicio WHERE creado_en > now() - interval '365 days' GROUP BY 1, 2`);
        const sla = await query(`
            SELECT prioridad, count(*)::int AS total, count(*) FILTER (WHERE resuelta_en <= sla_hasta)::int AS en_sla,
                   avg(EXTRACT(EPOCH FROM resuelta_en - creado_en) / 3600)::float8 AS horas
            FROM solicitudes_servicio WHERE resuelta_en IS NOT NULL GROUP BY prioridad`);
        res.json({
            porDiaHora: calor.rows,
            sla: sla.rows.map(f => ({ prioridad: f.prioridad, total: f.total, cumplimiento: Math.round(1000 * f.en_sla / f.total) / 10, horasPromedio: Math.round(f.horas * 10) / 10 }))
        });
    } catch (e) { next(e); }
});

router.get('/modelos', async (req, res, next) => {
    try {
        const r = await query('SELECT nombre, algoritmo, version, metricas, filas, entrenado_en FROM modelos_ml ORDER BY nombre');
        res.json({ datos: r.rows.map(f => ({ nombre: f.nombre, algoritmo: f.algoritmo, version: f.version, metricas: f.metricas, filas: f.filas, entrenadoEn: f.entrenado_en })) });
    } catch (e) { next(e); }
});

module.exports = router;

// POST /api/ml/entrenar (se monta aparte en app.js)
module.exports.entrenar = [permitirRoles(ROL_SUPERVISOR), async (req, res, next) => {
    try { res.json(await entrenarTodo()); } catch (e) { next(e); }
}];
