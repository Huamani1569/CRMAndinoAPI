// Funciones compartidas por las rutas de interacciones y tareas.
const { ErrorHttp, ROL_VENDEDOR } = require('../errores');

// Valida el :id numérico de la URL.
function validarIdParam(router) {
    router.param('id', (req, res, next, id) => {
        if (!/^\d+$/.test(id)) return res.status(404).json({ error: 'NO_ENCONTRADO', mensaje: 'Identificador no válido.' });
        next();
    });
}

// Busca el lead por su uuid y verifica que el vendedor pueda trabajar con él.
async function leadPermitido(cliente, usuario, leadUuid) {
    const r = await cliente.query(
        `SELECT l.id, l.vendedor_id, l.eliminado, u.nombre AS vendedor_nombre
         FROM leads l JOIN usuarios u ON u.id = l.vendedor_id
         WHERE l.uuid = $1 FOR SHARE OF l`,
        [leadUuid]
    );
    const lead = r.rows[0];
    if (!lead) {
        throw new ErrorHttp(422, 'LEAD_NO_EXISTE', 'El lead todavía no existe en el servidor (sincroniza primero el lead).');
    }
    if (lead.eliminado) {
        throw new ErrorHttp(409, 'ELIMINADO', 'El supervisor descartó este lead; ya no acepta cambios.');
    }
    if (usuario.rol === ROL_VENDEDOR && lead.vendedor_id !== usuario.id) {
        throw new ErrorHttp(409, 'REASIGNADO', `Este lead fue reasignado a ${lead.vendedor_nombre}; ya no puedes registrar cambios.`);
    }
    return lead;
}

module.exports = { validarIdParam, leadPermitido };
