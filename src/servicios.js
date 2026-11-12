// Funciones de apoyo que comparten varias rutas.
const { ROL_SUPERVISOR } = require('./errores');

// Crea notificaciones en la bandeja de uno o varios usuarios (las apps las descargan al sincronizar).
async function notificar(cliente, usuarioIds, tipo, titulo, cuerpo, refTipo = null, refId = null) {
    const ids = [...new Set((Array.isArray(usuarioIds) ? usuarioIds : [usuarioIds]).filter(Boolean))];
    for (const id of ids) {
        await cliente.query(
            'INSERT INTO notificaciones (usuario_id, tipo, titulo, cuerpo, ref_tipo, ref_id) VALUES ($1, $2, $3, $4, $5, $6)',
            [id, tipo, titulo.slice(0, 120), cuerpo.slice(0, 300), refTipo, refId]);
    }
}

async function usuariosDeCliente(cliente, clienteId) {
    const r = await cliente.query("SELECT id FROM usuarios WHERE cliente_id = $1 AND rol = 'cliente' AND activo", [clienteId]);
    return r.rows.map(f => f.id);
}

async function supervisores(cliente) {
    const r = await cliente.query('SELECT id FROM usuarios WHERE rol = $1 AND activo', [ROL_SUPERVISOR]);
    return r.rows.map(f => f.id);
}

// Distancia en metros entre dos coordenadas (fórmula de Haversine)
function distanciaMetros(lat1, lon1, lat2, lon2) {
    const R = 6371000, rad = (g) => g * Math.PI / 180;
    const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

// Vendedor para un lead del Portal: el de la cuenta; si no tiene, el del territorio con menos leads abiertos
async function elegirVendedor(cliente, clienteId) {
    const c = await cliente.query('SELECT vendedor_id, distrito FROM clientes WHERE id = $1', [clienteId]);
    if (c.rows[0]?.vendedor_id) return c.rows[0].vendedor_id;
    const r = await cliente.query(`
        SELECT u.id FROM usuarios u
        LEFT JOIN leads l ON l.vendedor_id = u.id AND l.etapa NOT IN ('GANADO','PERDIDO') AND NOT l.eliminado
        WHERE u.rol = 'vendedor' AND u.activo
        GROUP BY u.id, u.territorio
        ORDER BY (u.territorio = $1) DESC NULLS LAST, count(l.id), u.id LIMIT 1`, [c.rows[0]?.distrito || '']);
    return r.rows[0].id;
}

async function siguienteNumero(cliente, prefijo) {
    return (await cliente.query('SELECT siguiente_numero($1) AS n', [prefijo])).rows[0].n;
}

const num = (v) => (v === null || v === undefined ? null : Number(v));

module.exports = { notificar, usuariosDeCliente, supervisores, distanciaMetros, elegirVendedor, siguienteNumero, num };
