// Endpoints de la App PORTAL DEL CLIENTE (autoservicio).
//   POST /api/portal/registro                        registro con RUC y consentimiento (sin token) · RF-P01, RF-P02
//   GET  /api/portal/perfil · PUT /api/portal/perfil  datos y preferencia de ofertas · RF-P11
//   POST /api/portal/solicitudes-cotizacion          crea un lead NUEVO con canal PORTAL · RF-P03
//   GET  /api/portal/solicitudes-cotizacion          mis solicitudes y su estado · RF-P04
//   GET  /api/portal/solicitudes-cotizacion/:codigo  seguimiento por código
//   GET  /api/portal/ofertas                         ofertas vigentes · RF-P10
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { verificarTokenGoogle } = require('../google');
const { query, transaccion } = require('../db');
const { requiereSesion, permitirRoles, generarToken } = require('../middleware/auth');
const { ejecutarOperacion } = require('../operaciones');
const { ErrorHttp, ROL_CLIENTE, esUuid } = require('../errores');
const { notificar, elegirVendedor, siguienteNumero } = require('../servicios');
const { puntuarLead } = require('../ml');

const router = express.Router();

// ---------------------------------------------------------------- Registro (sin sesión)
router.post('/registro', async (req, res, next) => {
    try {
        const b = req.body || {};
        const ruc = String(b.ruc ?? '').replace(/\D/g, '');
        const razon = String(b.razonSocial ?? '').trim();
        const contacto = String(b.contacto ?? '').trim();
        const telefono = String(b.telefono ?? '').replace(/\D/g, '');
        // Registro con Google (API externa): el correo verificado viene del token; la contraseña es opcional
        const google = b.googleIdToken ? await verificarTokenGoogle(b.googleIdToken) : null;
        const correo = google ? google.correo : String(b.correo ?? '').trim().toLowerCase();
        const clave = google && String(b.clave ?? '').length < 8 ? crypto.randomBytes(18).toString('base64') : String(b.clave ?? '');
        const errores = [];
        if (!/^(10|15|17|20)\d{9}$/.test(ruc)) errores.push(['RUC_INVALIDO', 'El RUC debe tener 11 dígitos y empezar en 10, 15, 17 o 20.']);
        if (!razon) errores.push(['RAZON_SOCIAL_OBLIGATORIA', 'Escribe la razón social de la empresa.']);
        if (!contacto) errores.push(['CONTACTO_OBLIGATORIO', 'Escribe el nombre del contacto.']);
        if (!/^9\d{8}$/.test(telefono)) errores.push(['TELEFONO_INVALIDO', 'El celular debe tener 9 dígitos y empezar en 9.']);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(correo)) errores.push(['CORREO_INVALIDO', 'El correo no tiene un formato válido.']);
        if (clave.length < 8) errores.push(['CLAVE_CORTA', 'La contraseña debe tener al menos 8 caracteres.']);
        if (b.aceptaTratamientoDatos !== true) errores.push(['CONSENTIMIENTO_REQUERIDO', 'Debes aceptar el uso de tus datos para registrarte (Ley 29733).']);
        if (errores.length) return res.status(422).json({ error: errores[0][0], mensaje: errores[0][1], errores: errores.map(([e, m]) => ({ error: e, mensaje: m })) });

        const resultado = await transaccion(async (c) => {
            const yaHay = await c.query('SELECT 1 FROM usuarios WHERE correo = $1', [correo]);
            if (yaHay.rowCount) throw new ErrorHttp(409, 'CORREO_EN_USO', 'Ese correo ya tiene una cuenta. Inicia sesión.');
            // RF-P02: si el RUC ya existe como cliente, la cuenta se vincula a él (no se duplica)
            const existente = await c.query('SELECT id, razon_social FROM clientes WHERE ruc = $1', [ruc]);
            let clienteId, vinculado = false, empresa = razon;
            if (existente.rowCount) {
                clienteId = existente.rows[0].id; vinculado = true; empresa = existente.rows[0].razon_social;
                if (b.aceptaOfertas === false) await c.query('UPDATE clientes SET acepta_ofertas = FALSE WHERE id = $1', [clienteId]);
            } else {
                const nuevo = await c.query(
                    'INSERT INTO clientes (ruc, razon_social, acepta_ofertas) VALUES ($1, $2, $3) RETURNING id',
                    [ruc, razon, b.aceptaOfertas !== false]);
                clienteId = nuevo.rows[0].id;
            }
            const hash = await bcrypt.hash(clave, 10);
            const u = await c.query(
                `INSERT INTO usuarios (nombre, correo, clave_hash, rol, cliente_id, telefono, consentimiento_en, google_sub)
                 VALUES ($1, $2, $3, 'cliente', $4, $5, now(), $6) RETURNING id, nombre, correo, rol, cliente_id`,
                [contacto, correo, hash, clienteId, telefono, google ? google.sub : null]);
            return { usuario: u.rows[0], vinculado, empresa };
        });
        const u = resultado.usuario;
        res.status(201).json({
            token: generarToken(u),
            usuario: { id: u.id, nombre: u.nombre, correo: u.correo, rol: u.rol, clienteId: u.cliente_id, empresa: resultado.empresa },
            vinculadoAClienteExistente: resultado.vinculado
        });
    } catch (error) {
        if (error instanceof ErrorHttp) return res.status(error.status).json(error.cuerpo());
        next(error);
    }
});

// A partir de aquí: solo el rol cliente
router.use(requiereSesion, permitirRoles(ROL_CLIENTE));

// ---------------------------------------------------------------- Perfil
async function perfil(usuarioId) {
    const r = await query(`
        SELECT u.nombre, u.correo, u.telefono, c.id AS cliente_id, c.ruc, c.razon_social, c.fecha_alta, c.acepta_ofertas,
               v.nombre AS vendedor, (c.puntaje_valor >= 70) AS preferente
        FROM usuarios u JOIN clientes c ON c.id = u.cliente_id LEFT JOIN usuarios v ON v.id = c.vendedor_id
        WHERE u.id = $1`, [usuarioId]);
    const f = r.rows[0];
    return {
        nombre: f.nombre, correo: f.correo, telefono: f.telefono,
        empresa: { id: f.cliente_id, ruc: f.ruc.trim(), razonSocial: f.razon_social, clienteDesde: f.fecha_alta },
        aceptaOfertas: f.acepta_ofertas, vendedorAsignado: f.vendedor, clientePreferente: f.preferente === true
    };
}

router.get('/perfil', async (req, res, next) => {
    try { res.json({ dato: await perfil(req.usuario.id) }); } catch (e) { next(e); }
});

router.put('/perfil', (req, res, next) =>
    ejecutarOperacion(req, res, next, 'perfil', 'ACTUALIZAR', async (c) => {
        if (req.body.telefono != null) {
            const tel = String(req.body.telefono).replace(/\D/g, '');
            if (!/^9\d{8}$/.test(tel)) throw new ErrorHttp(422, 'TELEFONO_INVALIDO', 'El celular debe tener 9 dígitos y empezar en 9.');
            await c.query('UPDATE usuarios SET telefono = $2 WHERE id = $1', [req.usuario.id, tel]);
        }
        if (typeof req.body.aceptaOfertas === 'boolean') {
            await c.query('UPDATE clientes SET acepta_ofertas = $2, actualizado_en = now() WHERE id = $1', [req.usuario.clienteId, req.body.aceptaOfertas]);
        }
        return { status: 200, cuerpo: { dato: await perfilCon(c, req.usuario.id) } };
    })
);

async function perfilCon(c, id) {
    const r = await c.query('SELECT u.telefono, c.acepta_ofertas FROM usuarios u JOIN clientes c ON c.id = u.cliente_id WHERE u.id = $1', [id]);
    return { telefono: r.rows[0].telefono, aceptaOfertas: r.rows[0].acepta_ofertas };
}

// ---------------------------------------------------------------- Solicitudes de cotización
const ESTADO_CLIENTE = { NUEVO: 'RECIBIDA', CONTACTADO: 'EN_PREPARACION', CALIFICADO: 'EN_PREPARACION', COTIZADO: 'COTIZADA', GANADO: 'CERRADA', PERDIDO: 'CERRADA' };

const SELECT_SOL = `
    SELECT l.id, l.uuid, l.codigo_seguimiento, l.etapa, l.comentario_cliente, l.creado_en, u.nombre AS vendedor,
           (SELECT co.id FROM cotizaciones co WHERE co.lead_id = l.id AND co.estado NOT IN ('BORRADOR','PEND_APROBACION') ORDER BY co.id DESC LIMIT 1) AS cotizacion_id,
           COALESCE((SELECT json_agg(json_build_object('productoId', p.id, 'nombre', p.nombre, 'cantidad', sp.cantidad) ORDER BY p.nombre)
                     FROM solicitud_productos sp JOIN productos p ON p.id = sp.producto_id WHERE sp.lead_id = l.id), '[]') AS productos
    FROM leads l JOIN usuarios u ON u.id = l.vendedor_id`;

const solDto = (f) => ({
    id: f.id, uuid: f.uuid, codigo: f.codigo_seguimiento, estado: ESTADO_CLIENTE[f.etapa], etapa: f.etapa,
    productos: f.productos, comentario: f.comentario_cliente, vendedorNombre: f.vendedor,
    cotizacionId: f.cotizacion_id, creadoEn: f.creado_en
});

router.get('/solicitudes-cotizacion', async (req, res, next) => {
    try {
        const r = await query(`${SELECT_SOL} WHERE l.cliente_id = $1 AND l.canal_origen = 'PORTAL' AND NOT l.eliminado ORDER BY l.creado_en DESC`,
            [req.usuario.clienteId]);
        res.json({ servidorTiempo: new Date().toISOString(), total: r.rowCount, datos: r.rows.map(solDto) });
    } catch (e) { next(e); }
});

router.get('/solicitudes-cotizacion/:codigo', async (req, res, next) => {
    try {
        const r = await query(`${SELECT_SOL} WHERE l.cliente_id = $1 AND l.codigo_seguimiento = $2`, [req.usuario.clienteId, req.params.codigo]);
        if (!r.rowCount) return res.status(404).json({ error: 'NO_ENCONTRADO', mensaje: 'No encontramos una solicitud con ese código.' });
        res.json({ dato: solDto(r.rows[0]) });
    } catch (e) { next(e); }
});

router.post('/solicitudes-cotizacion', (req, res, next) =>
    ejecutarOperacion(req, res, next, 'solicitud_cotizacion', 'CREAR', async (c) => {
        const b = req.body;
        if (!esUuid(b.uuid)) throw new ErrorHttp(422, 'UUID_INVALIDO', 'La solicitud debe tener un uuid válido.');
        const existente = await c.query(`${SELECT_SOL} WHERE l.uuid = $1`, [b.uuid]);
        if (existente.rowCount) return { status: 200, cuerpo: { dato: solDto(existente.rows[0]) } };   // reenvío sin conexión: no se duplica

        const items = (Array.isArray(b.productos) ? b.productos : [])
            .map(p => ({ productoId: Number(p.productoId), cantidad: Math.floor(Number(p.cantidad)) }))
            .filter(p => Number.isInteger(p.productoId) && p.cantidad > 0);
        if (!items.length) throw new ErrorHttp(422, 'SIN_PRODUCTOS', 'Elige al menos un producto con su cantidad.');
        const prods = await c.query('SELECT id, precio::float8 AS precio FROM productos WHERE activo AND id = ANY($1)', [items.map(i => i.productoId)]);
        if (prods.rowCount !== new Set(items.map(i => i.productoId)).size) throw new ErrorHttp(422, 'PRODUCTO_INVALIDO', 'Uno de los productos no existe.');
        const precio = new Map(prods.rows.map(p => [p.id, p.precio]));
        const valor = items.reduce((s, i) => s + precio.get(i.productoId) * i.cantidad, 0);

        const u = (await c.query(`SELECT u.nombre, u.telefono, u.correo, c.id AS cliente_id, c.ruc, c.razon_social, c.latitud, c.longitud, c.direccion
                                  FROM usuarios u JOIN clientes c ON c.id = u.cliente_id WHERE u.id = $1`, [req.usuario.id])).rows[0];
        const vendedor = await elegirVendedor(c, u.cliente_id);
        const codigo = await siguienteNumero(c, 'SOL');
        const comentario = String(b.comentario ?? '').trim().slice(0, 500) || null;
        const lead = await c.query(
            `INSERT INTO leads (uuid, empresa, contacto, telefono, correo, ruc, valor_potencial, etapa, vendedor_id, canal_origen,
                                codigo_seguimiento, comentario_cliente, cliente_id, latitud, longitud, direccion)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'NUEVO', $8, 'PORTAL', $9, $10, $11, $12, $13, $14) RETURNING id`,
            [b.uuid, u.razon_social, u.nombre, u.telefono, u.correo, u.ruc, valor, vendedor, codigo, comentario, u.cliente_id,
                u.latitud, u.longitud, u.direccion]);
        const leadId = lead.rows[0].id;
        for (const i of items) {
            await c.query(`INSERT INTO solicitud_productos (lead_id, producto_id, cantidad) VALUES ($1, $2, $3)
                           ON CONFLICT (lead_id, producto_id) DO UPDATE SET cantidad = solicitud_productos.cantidad + EXCLUDED.cantidad`,
                [leadId, i.productoId, i.cantidad]);
        }
        const puntaje = await puntuarLead(c, leadId);
        await notificar(c, vendedor, 'LEAD_PORTAL', 'Nuevo lead del Portal',
            `${u.razon_social}${puntaje != null ? ` · ${puntaje} pts` : ''} · ${codigo}`, 'lead', leadId);
        const r = await c.query(`${SELECT_SOL} WHERE l.id = $1`, [leadId]);
        return { status: 201, cuerpo: { dato: solDto(r.rows[0]) } };
    })
);

// ---------------------------------------------------------------- Ofertas
router.get('/ofertas', async (req, res, next) => {
    try {
        const r = await query(`
            SELECT ca.id, ca.nombre, ca.oferta, ca.descuento_pct::float8 AS descuento, ca.fin, p.nombre AS producto,
                   bool_or(rc.respondio) AS ya_respondio, cl.acepta_ofertas
            FROM campanas ca
            JOIN respuestas_campana rc ON rc.campana_id = ca.id AND rc.cliente_id = $1
            JOIN clientes cl ON cl.id = rc.cliente_id
            LEFT JOIN productos p ON p.id = ca.producto_id
            WHERE ca.estado = 'ENVIADA' AND CURRENT_DATE BETWEEN ca.inicio AND ca.fin
            GROUP BY ca.id, p.nombre, cl.acepta_ofertas ORDER BY ca.fin`, [req.usuario.clienteId]);
        const datos = r.rows.filter(f => f.acepta_ofertas).map(f => ({
            campanaId: f.id, titulo: f.producto ? `${f.producto}${f.descuento ? ` · −${f.descuento} %` : ''}` : f.nombre,
            descripcion: f.oferta, descuentoPct: f.descuento, validaHasta: f.fin, yaRespondio: f.ya_respondio === true
        }));
        res.json({ servidorTiempo: new Date().toISOString(), total: datos.length, datos });
    } catch (e) { next(e); }
});

module.exports = router;
