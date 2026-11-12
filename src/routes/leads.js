// Endpoints de LEADS (cartera y embudo).
//   GET    /api/leads                  vendedor: sus leads · supervisor: todos (filtros y orden por puntaje)
//   GET    /api/leads/:id
//   GET    /api/leads/:id/historial    etapas, reasignaciones y puntaje (RNF-09)
//   POST   /api/leads                  solo vendedor (canal VENDEDOR)
//   PUT    /api/leads/reasignar        solo supervisor: reasignación en lote (RF-S03)
//   PUT    /api/leads/:id              editar datos (vendedor: los suyos · supervisor: también reasigna)
//   PUT    /api/leads/:id/etapa        cambiar etapa con validación de transición
//   DELETE /api/leads/:id              solo supervisor (descartar lead)
const express = require('express');
const { query } = require('../db');
const { permitirRoles } = require('../middleware/auth');
const { ejecutarOperacion } = require('../operaciones');
const { ErrorHttp, ETAPAS, ETAPAS_ABIERTAS, ROL_VENDEDOR, ROL_SUPERVISOR, esUuid } = require('../errores');
const { notificar, num } = require('../servicios');
const { puntuarLead } = require('../ml');

const router = express.Router();

// Solo vendedor y supervisor trabajan con leads, interacciones y tareas
router.use(permitirRoles(ROL_VENDEDOR, ROL_SUPERVISOR));
router.param('id', (req, res, next, id) => {
    if (!/^\d+$/.test(id)) return res.status(404).json({ error: 'NO_ENCONTRADO', mensaje: 'Identificador no válido.' });
    next();
});

const SELECT_LEAD = `
    SELECT l.id, l.uuid, l.empresa, l.contacto, l.telefono, l.correo, l.ruc, l.valor_potencial::float8 AS valor_potencial,
           l.etapa, l.canal_origen, l.codigo_seguimiento, l.puntaje, l.puntaje_factores, l.motivo_perdida, l.cliente_id,
           l.direccion, l.latitud::float8 AS latitud, l.longitud::float8 AS longitud, l.comentario_cliente,
           l.vendedor_id, u.nombre AS vendedor_nombre, l.version, l.eliminado, l.creado_en, l.actualizado_en,
           GREATEST(0, floor(EXTRACT(EPOCH FROM now() - COALESCE(l.ultimo_contacto_en, l.creado_en)) / 86400))::int AS dias_sin_contacto
    FROM leads l
    JOIN usuarios u ON u.id = l.vendedor_id`;

function aDto(f) {
    return {
        id: f.id,
        uuid: f.uuid,
        empresa: f.empresa,
        contacto: f.contacto,
        telefono: f.telefono,
        correo: f.correo,
        ruc: f.ruc ? f.ruc.trim() : null,
        valorPotencial: Number(f.valor_potencial),
        etapa: f.etapa,
        canalOrigen: f.canal_origen,
        codigoSeguimiento: f.codigo_seguimiento,
        puntaje: f.puntaje,
        puntajeFactores: f.puntaje_factores || [],
        diasSinContacto: f.dias_sin_contacto,
        motivoPerdida: f.motivo_perdida,
        clienteId: f.cliente_id,
        direccion: f.direccion,
        latitud: num(f.latitud),
        longitud: num(f.longitud),
        comentarioCliente: f.comentario_cliente,
        vendedorId: f.vendedor_id,
        vendedorNombre: f.vendedor_nombre,
        version: f.version,
        eliminado: f.eliminado,
        creadoEn: f.creado_en,
        actualizadoEn: f.actualizado_en
    };
}

async function buscarLead(cliente, id, bloquear = false) {
    const r = await cliente.query(`${SELECT_LEAD} WHERE l.id = $1 ${bloquear ? 'FOR UPDATE OF l' : ''}`, [id]);
    return r.rows[0];
}

// Reglas de negocio del lead (validación en el servidor).
function validarLead(body) {
    const empresa = String(body.empresa ?? '').trim();
    const contacto = String(body.contacto ?? '').trim();
    const valor = Number(body.valorPotencial ?? 0);
    const telefono = body.telefono ? String(body.telefono).replace(/\D/g, '') : null;
    const correo = body.correo ? String(body.correo).trim().toLowerCase() : null;
    const ruc = body.ruc ? String(body.ruc).replace(/\D/g, '') : null;
    if (!empresa) throw new ErrorHttp(422, 'EMPRESA_OBLIGATORIA', 'No se puede guardar un lead sin empresa.');
    if (!contacto) throw new ErrorHttp(422, 'CONTACTO_OBLIGATORIO', 'Escribe el nombre del contacto.');
    if (!Number.isFinite(valor) || valor < 0) throw new ErrorHttp(422, 'VALOR_INVALIDO', 'El valor potencial debe ser un número mayor o igual a 0.');
    if (telefono && !/^9\d{8}$/.test(telefono)) throw new ErrorHttp(422, 'TELEFONO_INVALIDO', 'El celular debe tener 9 dígitos y empezar en 9.');
    if (correo && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(correo)) throw new ErrorHttp(422, 'CORREO_INVALIDO', 'El correo no tiene un formato válido.');
    if (ruc && !/^\d{11}$/.test(ruc)) throw new ErrorHttp(422, 'RUC_INVALIDO', 'El RUC debe tener 11 dígitos.');
    const lat = body.latitud == null ? null : Number(body.latitud);
    const lon = body.longitud == null ? null : Number(body.longitud);
    return { empresa, contacto, valor, telefono, correo, ruc, lat, lon, direccion: body.direccion ? String(body.direccion).trim() : null };
}

// ---------- Consultas ----------
const ORDENES = {
    puntaje: 'l.puntaje DESC NULLS LAST, l.id',
    reciente: 'l.creado_en DESC',
    dias_sin_contacto: 'COALESCE(l.ultimo_contacto_en, l.creado_en) ASC'
};

router.get('/', async (req, res, next) => {
    try {
        const cond = [], par = [];
        const p = (v) => { par.push(v); return `$${par.length}`; };
        if (req.usuario.rol === ROL_VENDEDOR) cond.push(`l.vendedor_id = ${p(req.usuario.id)}`);
        else if (req.query.vendedorId) cond.push(`l.vendedor_id = ${p(Number(req.query.vendedorId))}`);
        if (req.query.etapa) cond.push(`l.etapa = ANY(${p(String(req.query.etapa).split(','))})`);
        if (req.query.canal) cond.push(`l.canal_origen = ${p(String(req.query.canal))}`);
        if (req.query.puntajeMin) cond.push(`l.puntaje >= ${p(Number(req.query.puntajeMin))}`);
        if (req.query.puntajeMax) cond.push(`l.puntaje <= ${p(Number(req.query.puntajeMax))}`);
        // ?desde=fecha → solo los cambios posteriores (incluye eliminados para que la app los quite)
        if (req.query.desde) cond.push(`l.actualizado_en > ${p(new Date(req.query.desde))}`);
        else cond.push('l.eliminado = FALSE');
        if (req.query.abiertos === '1') cond.push("l.etapa NOT IN ('GANADO','PERDIDO')");
        const orden = ORDENES[req.query.orden] || ORDENES.puntaje;
        const r = await query(`${SELECT_LEAD} WHERE ${cond.join(' AND ')} ORDER BY ${orden}`, par);
        res.json({ servidorTiempo: new Date().toISOString(), total: r.rowCount, datos: r.rows.map(aDto) });
    } catch (error) {
        next(error);
    }
});

router.get('/:id', async (req, res, next) => {
    try {
        const r = await query(`${SELECT_LEAD} WHERE l.id = $1 AND l.eliminado = FALSE`, [req.params.id]);
        const lead = r.rows[0];
        if (!lead || (req.usuario.rol === ROL_VENDEDOR && lead.vendedor_id !== req.usuario.id)) {
            return res.status(404).json({ error: 'NO_ENCONTRADO', mensaje: 'Lead no encontrado.' });
        }
        const productos = await query(`SELECT p.id AS "productoId", p.nombre, sp.cantidad FROM solicitud_productos sp
                                       JOIN productos p ON p.id = sp.producto_id WHERE sp.lead_id = $1`, [lead.id]);
        res.json({ dato: { ...aDto(lead), productosSolicitados: productos.rows } });
    } catch (error) {
        next(error);
    }
});

router.get('/:id/historial', async (req, res, next) => {
    try {
        const lead = (await query('SELECT vendedor_id FROM leads WHERE id = $1', [req.params.id])).rows[0];
        if (!lead || (req.usuario.rol === ROL_VENDEDOR && lead.vendedor_id !== req.usuario.id)) {
            return res.status(404).json({ error: 'NO_ENCONTRADO', mensaje: 'Lead no encontrado.' });
        }
        const r = await query(`
            SELECT h.campo, h.valor_anterior, h.valor_nuevo, h.fecha, u.nombre AS usuario,
                   va.nombre AS vendedor_anterior, vn.nombre AS vendedor_nuevo
            FROM historial_lead h LEFT JOIN usuarios u ON u.id = h.usuario_id
            LEFT JOIN usuarios va ON h.campo = 'VENDEDOR' AND va.id::text = h.valor_anterior
            LEFT JOIN usuarios vn ON h.campo = 'VENDEDOR' AND vn.id::text = h.valor_nuevo
            WHERE h.lead_id = $1 ORDER BY h.fecha DESC, h.id DESC`, [req.params.id]);
        res.json({
            servidorTiempo: new Date().toISOString(), total: r.rowCount,
            datos: r.rows.map(f => ({
                campo: f.campo,
                valorAnterior: f.campo === 'VENDEDOR' ? f.vendedor_anterior : f.valor_anterior,
                valorNuevo: f.campo === 'VENDEDOR' ? f.vendedor_nuevo : f.valor_nuevo,
                usuarioNombre: f.usuario || 'Sistema',
                fecha: f.fecha
            }))
        });
    } catch (error) {
        next(error);
    }
});

// ---------- Escrituras (todas con X-Operacion-UUID) ----------
router.post('/', permitirRoles(ROL_VENDEDOR), (req, res, next) =>
    ejecutarOperacion(req, res, next, 'lead', 'CREAR', async (cliente) => {
        if (!esUuid(req.body.uuid)) throw new ErrorHttp(422, 'UUID_INVALIDO', 'El lead debe tener un uuid válido.');
        const d = validarLead(req.body);

        // Si el lead ya existe con ese uuid (se creó antes), no se duplica: se devuelve el existente.
        const existente = await cliente.query('SELECT id, vendedor_id FROM leads WHERE uuid = $1', [req.body.uuid]);
        if (existente.rowCount > 0) {
            if (existente.rows[0].vendedor_id !== req.usuario.id) {
                throw new ErrorHttp(409, 'UUID_EN_USO', 'Ya existe otro lead con ese identificador.');
            }
            return { status: 200, cuerpo: { dato: aDto(await buscarLead(cliente, existente.rows[0].id)) } };
        }
        const etapa = ETAPAS_ABIERTAS.includes(req.body.etapa) ? req.body.etapa : 'NUEVO';
        const r = await cliente.query(
            `INSERT INTO leads (uuid, empresa, contacto, telefono, correo, ruc, valor_potencial, etapa, vendedor_id, canal_origen,
                                direccion, latitud, longitud)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'VENDEDOR', $10, $11, $12) RETURNING id`,
            [req.body.uuid, d.empresa, d.contacto, d.telefono, d.correo, d.ruc, d.valor, etapa, req.usuario.id, d.direccion, d.lat, d.lon]
        );
        await puntuarLead(cliente, r.rows[0].id);
        return { status: 201, cuerpo: { dato: aDto(await buscarLead(cliente, r.rows[0].id)) } };
    })
);

router.put('/reasignar', permitirRoles(ROL_SUPERVISOR), (req, res, next) =>
    ejecutarOperacion(req, res, next, 'lead', 'REASIGNAR', async (cliente) => {
        const ids = Array.isArray(req.body.leadIds) ? req.body.leadIds.map(Number).filter(Number.isInteger) : [];
        const destino = Number(req.body.vendedorDestinoId);
        if (!ids.length) throw new ErrorHttp(422, 'SIN_LEADS', 'Selecciona al menos un lead.');
        const v = await cliente.query("SELECT id, nombre FROM usuarios WHERE id = $1 AND rol = 'vendedor' AND activo", [destino]);
        if (!v.rowCount) throw new ErrorHttp(422, 'VENDEDOR_INVALIDO', 'El vendedor elegido no existe o no está activo.');
        const r = await cliente.query(
            `UPDATE leads SET vendedor_id = $2, version = version + 1, actualizado_en = now()
             WHERE id = ANY($1) AND NOT eliminado AND vendedor_id <> $2 RETURNING id, empresa`, [ids, destino]);
        if (r.rowCount) {
            await notificar(cliente, destino, 'LEADS_REASIGNADOS', `Te asignaron ${r.rowCount} lead(s)`,
                r.rows.slice(0, 3).map(f => f.empresa).join(', ') + (r.rowCount > 3 ? '…' : ''), 'lead', r.rows[0].id);
        }
        return { status: 200, cuerpo: { reasignados: r.rowCount, vendedorDestino: v.rows[0].nombre } };
    })
);

router.put('/:id', permitirRoles(ROL_VENDEDOR, ROL_SUPERVISOR), (req, res, next) =>
    ejecutarOperacion(req, res, next, 'lead', 'ACTUALIZAR', async (cliente) => {
        const actual = await buscarLead(cliente, req.params.id, true);
        if (!actual) throw new ErrorHttp(404, 'NO_ENCONTRADO', 'El lead no existe en el servidor.');
        if (actual.eliminado) {
            throw new ErrorHttp(409, 'ELIMINADO', 'El supervisor descartó este lead; ya no se puede modificar.', { actual: aDto(actual) });
        }
        if (req.usuario.rol === ROL_VENDEDOR && actual.vendedor_id !== req.usuario.id) {
            throw new ErrorHttp(409, 'REASIGNADO', `Este lead fue reasignado a ${actual.vendedor_nombre}; ya no puedes modificarlo.`, { actual: aDto(actual) });
        }
        // CONTROL DE CONFLICTOS: la app envía la versión que tenía cuando hizo el cambio.
        if (Number(req.body.version) !== actual.version) {
            throw new ErrorHttp(409, 'CONFLICTO_VERSION',
                `Otro usuario modificó este lead (versión del servidor ${actual.version}, tu cambio partía de la versión ${req.body.version}).`,
                { actual: aDto(actual) });
        }
        const d = validarLead({ ...aDto(actual), ...req.body });

        let vendedorId = actual.vendedor_id;
        if (req.usuario.rol === ROL_SUPERVISOR && req.body.vendedorId != null && Number(req.body.vendedorId) !== actual.vendedor_id) {
            const v = await cliente.query("SELECT id FROM usuarios WHERE id = $1 AND rol = 'vendedor' AND activo = TRUE", [req.body.vendedorId]);
            if (v.rowCount === 0) throw new ErrorHttp(422, 'VENDEDOR_INVALIDO', 'El vendedor elegido no existe o no está activo.');
            vendedorId = v.rows[0].id;
            await notificar(cliente, vendedorId, 'LEADS_REASIGNADOS', 'Te asignaron un lead', actual.empresa, 'lead', actual.id);
        }
        await cliente.query(
            `UPDATE leads SET empresa = $2, contacto = $3, valor_potencial = $4, vendedor_id = $5, telefono = $6, correo = $7, ruc = $8,
                    direccion = $9, latitud = $10, longitud = $11, version = version + 1, actualizado_en = now()
             WHERE id = $1`,
            [actual.id, d.empresa, d.contacto, d.valor, vendedorId, d.telefono, d.correo, d.ruc, d.direccion, d.lat, d.lon]
        );
        return { status: 200, cuerpo: { dato: aDto(await buscarLead(cliente, actual.id)) } };
    })
);

router.put('/:id/etapa', permitirRoles(ROL_VENDEDOR, ROL_SUPERVISOR), (req, res, next) =>
    ejecutarOperacion(req, res, next, 'lead', 'ETAPA', async (cliente) => {
        const actual = await buscarLead(cliente, req.params.id, true);
        if (!actual || actual.eliminado) throw new ErrorHttp(404, 'NO_ENCONTRADO', 'El lead no existe en el servidor.');
        if (req.usuario.rol === ROL_VENDEDOR && actual.vendedor_id !== req.usuario.id) {
            throw new ErrorHttp(409, 'REASIGNADO', `Este lead fue reasignado a ${actual.vendedor_nombre}.`, { actual: aDto(actual) });
        }
        if (req.body.version != null && Number(req.body.version) !== actual.version) {
            throw new ErrorHttp(409, 'CONFLICTO_VERSION', `El lead cambió en el servidor (versión ${actual.version}).`, { actual: aDto(actual) });
        }
        const etapa = req.body.etapa;
        if (!ETAPAS.includes(etapa)) throw new ErrorHttp(422, 'ETAPA_INVALIDA', `La etapa debe ser una de: ${ETAPAS.join(', ')}.`);
        if (etapa === actual.etapa) return { status: 200, cuerpo: { dato: aDto(actual) } };
        const motivo = String(req.body.motivoPerdida ?? '').trim() || null;
        if (etapa === 'PERDIDO' && !motivo) throw new ErrorHttp(422, 'MOTIVO_OBLIGATORIO', 'Indica por qué se perdió el lead.');

        // RN-05: un lead GANADO crea la cuenta del cliente; si el RUC ya existe se reutiliza
        let clienteId = actual.cliente_id;
        if (etapa === 'GANADO' && !clienteId) {
            const ruc = actual.ruc ? actual.ruc.trim() : null;
            if (!ruc) throw new ErrorHttp(422, 'RUC_OBLIGATORIO', 'Para marcar el lead como GANADO registra primero el RUC de la empresa.');
            const c = await cliente.query(
                `INSERT INTO clientes (ruc, razon_social, vendedor_id, latitud, longitud) VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (ruc) DO UPDATE SET actualizado_en = now() RETURNING id`,
                [ruc, actual.empresa, actual.vendedor_id, actual.latitud, actual.longitud]);
            clienteId = c.rows[0].id;
        }
        await cliente.query(
            `UPDATE leads SET etapa = $2::varchar, motivo_perdida = CASE WHEN $2::varchar = 'PERDIDO' THEN $3::varchar ELSE motivo_perdida END,
                    cliente_id = $4, version = version + 1, actualizado_en = now() WHERE id = $1`,
            [actual.id, etapa, motivo, clienteId]);
        await puntuarLead(cliente, actual.id);
        return { status: 200, cuerpo: { dato: aDto(await buscarLead(cliente, actual.id)) } };
    })
);

router.delete('/:id', permitirRoles(ROL_SUPERVISOR), (req, res, next) =>
    ejecutarOperacion(req, res, next, 'lead', 'ELIMINAR', async (cliente) => {
        const actual = await buscarLead(cliente, req.params.id, true);
        if (!actual) throw new ErrorHttp(404, 'NO_ENCONTRADO', 'El lead no existe en el servidor.');
        if (actual.eliminado) return { status: 200, cuerpo: { dato: aDto(actual) } }; // ya estaba eliminado

        if (req.query.version != null && Number(req.query.version) !== actual.version) {
            throw new ErrorHttp(409, 'CONFLICTO_VERSION',
                `El lead cambió desde que lo viste (versión del servidor ${actual.version}). Revísalo antes de eliminarlo.`,
                { actual: aDto(actual) });
        }
        // Borrado lógico del lead y de sus tareas e interacciones.
        await cliente.query('UPDATE leads SET eliminado = TRUE, version = version + 1, actualizado_en = now() WHERE id = $1', [actual.id]);
        await cliente.query('UPDATE tareas SET eliminado = TRUE, version = version + 1, actualizado_en = now() WHERE lead_id = $1', [actual.id]);
        await cliente.query('UPDATE interacciones SET eliminado = TRUE, version = version + 1, actualizado_en = now() WHERE lead_id = $1', [actual.id]);
        return { status: 200, cuerpo: { dato: aDto(await buscarLead(cliente, actual.id)) } };
    })
);

module.exports = router;
module.exports.aDtoLead = aDto;
module.exports.SELECT_LEAD = SELECT_LEAD;
