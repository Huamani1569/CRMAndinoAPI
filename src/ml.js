// =====================================================================
// CRM analítica · Modelos de ML de la Semana 14 (se entrenan dentro de la API)
//   ML-01 Lead scoring ........ regresión logística: probabilidad de cierre
//   ML-02 Riesgo de cancelación  regresión logística con explicación de factores
//   ML-03 Valor y lealtad ...... puntaje RFM de 0 a 100 (sin entrenamiento)
//   ML-04 Venta cruzada ........ reglas de asociación (Apriori de 2 productos)
// El notebook ml/CRM_Andino_ML.ipynb repite el análisis con scikit-learn
// (y compara con Random Forest y Gradient Boosting).
// =====================================================================
const { query, transaccion } = require('./db');

// ---------------------------------------------------------------- utilidades
const sigmoide = (z) => 1 / (1 + Math.exp(-z));

function auc(etiquetas, puntajes) {
    const pares = etiquetas.map((y, i) => [puntajes[i], y]).sort((a, b) => a[0] - b[0]);
    let rango = 0, pos = 0;
    pares.forEach(([, y], i) => { if (y === 1) { rango += i + 1; pos++; } });
    const neg = pares.length - pos;
    if (!pos || !neg) return null;
    return (rango - pos * (pos + 1) / 2) / (pos * neg);
}

// Regresión logística con descenso de gradiente y regularización L2 (variables estandarizadas)
function entrenarLogistica(X, y, { iter = 3000, tasa = 0.1, l2 = 0.01 } = {}) {
    const n = X.length, k = X[0].length;
    const medias = Array(k).fill(0), desv = Array(k).fill(0);
    X.forEach(f => f.forEach((v, j) => { medias[j] += v / n; }));
    X.forEach(f => f.forEach((v, j) => { desv[j] += (v - medias[j]) ** 2 / n; }));
    for (let j = 0; j < k; j++) desv[j] = Math.sqrt(desv[j]) || 1;
    const Z = X.map(f => f.map((v, j) => (v - medias[j]) / desv[j]));
    let w = Array(k).fill(0), b = 0;
    for (let t = 0; t < iter; t++) {
        const gw = Array(k).fill(0); let gb = 0;
        for (let i = 0; i < n; i++) {
            const e = sigmoide(b + Z[i].reduce((s, z, j) => s + z * w[j], 0)) - y[i];
            gb += e / n;
            for (let j = 0; j < k; j++) gw[j] += e * Z[i][j] / n;
        }
        b -= tasa * gb;
        w = w.map((wj, j) => wj - tasa * (gw[j] + l2 * wj));
    }
    return { medias, desv, pesos: w, sesgo: b };
}

function predecir(modelo, x) {
    const z = x.map((v, j) => (v - modelo.medias[j]) / modelo.desv[j]);
    const contrib = z.map((zj, j) => zj * modelo.pesos[j]);
    return { prob: sigmoide(modelo.sesgo + contrib.reduce((s, c) => s + c, 0)), contrib };
}

// Explicación: los factores que más empujan la predicción (hacia arriba o abajo)
function factores(contrib, nombres, valores, n = 3) {
    return contrib.map((c, j) => ({ factor: nombres[j](valores[j], c), peso: Math.round(c * 100) / 100 }))
        .sort((a, b) => Math.abs(b.peso) - Math.abs(a.peso)).slice(0, n);
}

// Separación entrenamiento / prueba reproducible (20 % para prueba)
const esPrueba = (id) => (id * 2654435761 % 2 ** 32) % 5 === 0;

// ---------------------------------------------------------------- ML-01 Lead scoring
const VARS_LEAD = ['etapa_idx', 'n_interacciones', 'dias_sin_contacto', 'n_visitas', 'canal_portal', 'canal_campana', 'log_valor'];
const ETIQ_LEAD = [
    (v) => `Etapa ${['NUEVO', 'CONTACTADO', 'CALIFICADO', 'COTIZADO'][v] || ''}`.trim(),
    (v) => `${v} interacciones registradas`,
    (v) => `${Math.round(v)} días sin contacto`,
    (v) => `${v} visitas en campo`,
    (v, c) => v ? 'Pidió cotización desde el Portal' : 'No vino del Portal',
    (v) => v ? 'Respondió a una campaña' : 'Sin campaña',
    (v) => `Valor potencial S/ ${Math.round(Math.exp(v)).toLocaleString('es-PE')}`
];
const filaLead = (r) => [r.etapa_idx ?? 0, r.n_interacciones, r.dias_sin_contacto, r.n_visitas, r.canal_portal, r.canal_campana, Math.log(Math.max(r.valor_potencial, 500))];

async function entrenarLeadScoring() {
    const r = await query('SELECT * FROM v_ml_leads');
    const cerrados = r.rows.filter(f => f.etiqueta !== null);
    const ent = cerrados.filter(f => !esPrueba(f.id)), pru = cerrados.filter(f => esPrueba(f.id));
    const modelo = entrenarLogistica(ent.map(filaLead), ent.map(f => f.etiqueta));
    const probs = pru.map(f => predecir(modelo, filaLead(f)).prob);
    const top = pru.map((f, i) => [probs[i], f.etiqueta]).sort((a, b) => b[0] - a[0]).slice(0, Math.max(1, Math.round(pru.length * 0.2)));
    const metricas = {
        auc: round(auc(pru.map(f => f.etiqueta), probs), 3),
        precisionTop20: round(top.filter(t => t[1] === 1).length / top.length, 3),
        tasaBase: round(cerrados.filter(f => f.etiqueta === 1).length / cerrados.length, 3),
        entrenamiento: ent.length, prueba: pru.length,
        coeficientes: Object.fromEntries(VARS_LEAD.map((v, j) => [v, round(modelo.pesos[j], 3)]))
    };
    // Puntaje de los leads abiertos (0 a 100) con su explicación
    const abiertos = r.rows.filter(f => f.etiqueta === null);
    await transaccion(async (c) => {
        await c.query("SELECT set_config('crm.usuario_id', '', true)");
        for (const f of abiertos) {
            const x = filaLead(f);
            const { prob, contrib } = predecir(modelo, x);
            await c.query('UPDATE leads SET puntaje = $2, puntaje_factores = $3 WHERE id = $1 AND puntaje IS DISTINCT FROM $2',
                [f.id, Math.round(prob * 100), JSON.stringify(factores(contrib, ETIQ_LEAD, x))]);
        }
        await guardarModelo(c, 'LEAD_SCORING', 'Regresión logística (descenso de gradiente, L2)', modelo, metricas, cerrados.length);
    });
    return { ...metricas, puntuados: abiertos.length };
}

// Puntaje inmediato de UN lead (al crearlo o al registrar una interacción)
async function puntuarLead(cliente, leadId) {
    const m = await cliente.query("SELECT parametros FROM modelos_ml WHERE nombre = 'LEAD_SCORING'");
    if (!m.rowCount) return null;
    const f = (await cliente.query('SELECT * FROM v_ml_leads WHERE id = $1', [leadId])).rows[0];
    if (!f || f.etiqueta !== null) return null;
    const x = filaLead(f);
    const { prob, contrib } = predecir(m.rows[0].parametros, x);
    const puntaje = Math.round(prob * 100);
    await cliente.query('UPDATE leads SET puntaje = $2, puntaje_factores = $3 WHERE id = $1 AND puntaje IS DISTINCT FROM $2',
        [leadId, puntaje, JSON.stringify(factores(contrib, ETIQ_LEAD, x))]);
    return puntaje;
}

// ---------------------------------------------------------------- ML-02 Churn + ML-03 RFM + CLTV
const VARS_CHURN = ['dias_ultima_compra', 'compras_12m', 'tendencia', 'tickets_180d', 'csat'];
const ETIQ_CHURN = [
    (v) => `${Math.round(v)} días desde la última compra`,
    (v) => `${v} compras en los últimos 12 meses`,
    (v) => v < 0 ? 'Compra menos que antes' : v > 0 ? 'Compra más que antes' : 'Compras estables',
    (v) => `${v} solicitudes de servicio en 6 meses`,
    (v) => `Satisfacción promedio ${v.toFixed(1)} de 5`
];
const filaCli = (r) => [Math.min(r.dias_ultima_compra, 400), r.compras_12m, r.tendencia, r.tickets_180d, r.csat];

function percentil(lista, v) {
    if (!lista.length) return 0.5;
    return lista.filter(x => x < v).length / lista.length;
}

async function entrenarClientes() {
    const r = await query('SELECT * FROM v_ml_clientes');
    const conHistoria = r.rows.filter(f => f.compras_total > 0);
    const ent = conHistoria.filter(f => !esPrueba(f.id)), pru = conHistoria.filter(f => esPrueba(f.id));
    const modelo = entrenarLogistica(ent.map(filaCli), ent.map(f => f.etiqueta), { l2: 0.02 });
    const probs = pru.map(f => predecir(modelo, filaCli(f)).prob);
    const umbral = 0.3;   // se prioriza no dejar escapar clientes que sí cancelan (recall)
    const reales = pru.filter(f => f.etiqueta === 1);
    const metricas = {
        auc: round(auc(pru.map(f => f.etiqueta), probs), 3),
        recall: reales.length ? round(pru.filter((f, i) => f.etiqueta === 1 && probs[i] >= umbral).length / reales.length, 3) : null,
        umbral, entrenamiento: ent.length, prueba: pru.length,
        coeficientes: Object.fromEntries(VARS_CHURN.map((v, j) => [v, round(modelo.pesos[j], 3)]))
    };

    // Margen por cliente (para CLTV y clientes rentables)
    const margen = await query(`
        SELECT l.cliente_id, sum(d.subtotal * (1 - co.descuento_pct / 100) * p.margen_pct / 100)::float8 AS margen,
               GREATEST(1, (CURRENT_DATE - min(co.respondida_en)::date) / 365.0)::float8 AS anios
        FROM cotizaciones co JOIN leads l ON l.id = co.lead_id
        JOIN cotizacion_detalle d ON d.cotizacion_id = co.id JOIN productos p ON p.id = d.producto_id
        WHERE co.estado = 'ACEPTADA' AND l.cliente_id IS NOT NULL GROUP BY l.cliente_id`);
    const mapaMargen = new Map(margen.rows.map(m => [m.cliente_id, m]));

    // ML-03: RFM sobre los clientes activos con compras
    const activos = r.rows.filter(f => f.compras_total > 0 && f.etiqueta === 0);
    const R = activos.map(f => f.dias_ultima_compra), F = activos.map(f => f.compras_total), M = activos.map(f => f.monto_total);

    await transaccion(async (c) => {
        for (const f of r.rows) {
            if (f.compras_total === 0) continue;
            const x = filaCli(f);
            const { prob, contrib } = predecir(modelo, x);
            const rfm = 100 * (0.35 * (1 - percentil(R, f.dias_ultima_compra)) + 0.30 * percentil(F, f.compras_total) + 0.35 * percentil(M, f.monto_total));
            const valor = Math.max(0, Math.min(100, Math.round(rfm * 0.85 + (f.csat - 3) * 7.5 + Math.min(f.dias_antiguedad / 365, 2) * 2.5)));
            const m = mapaMargen.get(f.id);
            const margenAnual = m ? m.margen / m.anios : 0;
            const anios = Math.min(10, 1 / Math.max(prob, 0.1));
            const cliente = await c.query('SELECT costo_adquisicion::float8 AS cac FROM clientes WHERE id = $1', [f.id]);
            const cltv = margenAnual * anios - cliente.rows[0].cac;
            await c.query(`UPDATE clientes SET puntaje_valor = $2, prob_cancelacion = $3, factores_riesgo = $4, cltv = $5, actualizado_en = now()
                           WHERE id = $1`,
                [f.id, f.etiqueta === 1 ? null : valor, f.etiqueta === 1 ? 1 : round(prob, 3),
                    JSON.stringify(factores(contrib, ETIQ_CHURN, x).filter(z => z.peso > 0).slice(0, 3)), round(cltv, 2)]);
        }
        await guardarModelo(c, 'CHURN', 'Regresión logística con factores por cliente', modelo, metricas, conHistoria.length);
        await guardarModelo(c, 'RFM', 'Puntaje RFM normalizado 0–100 + satisfacción + antigüedad',
            { pesos: { recencia: 0.35, frecuencia: 0.30, monto: 0.35 } },
            { clientes: activos.length, altoValor: activos.length ? undefined : 0 }, activos.length);
    });
    const alto = await query('SELECT count(*)::int AS n FROM clientes WHERE puntaje_valor >= 70 AND cancelado_en IS NULL');
    return { ...metricas, clientesPuntuados: conHistoria.length, clientesAltoValor: alto.rows[0].n };
}

// ---------------------------------------------------------------- ML-04 Apriori (pares)
async function entrenarApriori({ soporteMin = 0.05, confianzaMin = 0.4 } = {}) {
    const r = await query(`
        SELECT l.cliente_id, array_agg(DISTINCT d.producto_id) AS productos
        FROM cotizaciones co JOIN leads l ON l.id = co.lead_id JOIN cotizacion_detalle d ON d.cotizacion_id = co.id
        WHERE co.estado = 'ACEPTADA' AND l.cliente_id IS NOT NULL GROUP BY l.cliente_id`);
    const cestas = r.rows.map(f => new Set(f.productos));
    const n = cestas.length;
    const sop1 = new Map();
    cestas.forEach(s => s.forEach(p => sop1.set(p, (sop1.get(p) || 0) + 1)));
    const reglas = [];
    for (const [a, na] of sop1) for (const [b, nb] of sop1) {
        if (a === b) continue;
        const nab = cestas.filter(s => s.has(a) && s.has(b)).length;
        const soporte = nab / n, confianza = nab / na, lift = confianza / (nb / n);
        if (soporte >= soporteMin && confianza >= confianzaMin && lift > 1) reglas.push({ a, b, soporte: round(soporte, 3), confianza: round(confianza, 3), lift: round(lift, 3) });
    }
    const nombres = new Map((await query('SELECT id, nombre FROM productos')).rows.map(p => [p.id, p.nombre]));
    await transaccion(async (c) => {
        await c.query('DELETE FROM recomendaciones');
        for (const f of r.rows) {
            const tiene = new Set(f.productos);
            const mejores = new Map();
            for (const rg of reglas) {
                if (tiene.has(rg.a) && !tiene.has(rg.b) && (!mejores.has(rg.b) || mejores.get(rg.b).confianza < rg.confianza)) mejores.set(rg.b, rg);
            }
            const top = [...mejores.values()].sort((x, y) => y.confianza - x.confianza).slice(0, 3);
            for (const rg of top) {
                await c.query(`INSERT INTO recomendaciones (cliente_id, producto_id, confianza, lift, razon) VALUES ($1, $2, $3, $4, $5)`,
                    [f.cliente_id, rg.b, rg.confianza, rg.lift,
                        `${Math.round(rg.confianza * 100)} % de los clientes que compraron ${nombres.get(rg.a)} también compraron ${nombres.get(rg.b)}`]);
            }
        }
        await guardarModelo(c, 'APRIORI', 'Reglas de asociación (Apriori, pares)', { soporteMin, confianzaMin },
            { reglas: reglas.map(rg => ({ si: nombres.get(rg.a), entonces: nombres.get(rg.b), soporte: rg.soporte, confianza: rg.confianza, lift: rg.lift })) }, n);
    });
    return { cestas: n, reglas: reglas.length };
}

async function guardarModelo(c, nombre, algoritmo, parametros, metricas, filas) {
    await c.query(`INSERT INTO modelos_ml (nombre, algoritmo, parametros, metricas, filas) VALUES ($1, $2, $3, $4, $5)
                   ON CONFLICT (nombre) DO UPDATE SET algoritmo = $2, parametros = $3, metricas = $4, filas = $5,
                   version = modelos_ml.version + 1, entrenado_en = now()`,
        [nombre, algoritmo, JSON.stringify(parametros), JSON.stringify(metricas), filas]);
}

function round(v, d) {
    return v === null || v === undefined || Number.isNaN(v) ? null : Math.round(v * 10 ** d) / 10 ** d;
}

// Orden: primero clientes (puntaje de valor), luego Apriori y al final leads
async function entrenarTodo() {
    const inicio = Date.now();
    const clientes = await entrenarClientes();
    const apriori = await entrenarApriori();
    const leads = await entrenarLeadScoring();
    return { leadScoring: leads, churn: clientes, apriori, segundos: round((Date.now() - inicio) / 1000, 1) };
}

module.exports = { entrenarTodo, puntuarLead, auc, entrenarLogistica, predecir };
