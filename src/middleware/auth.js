// Autenticación con JWT: la app envía "Authorization: Bearer <token>" en cada petición.
const jwt = require('jsonwebtoken');

function secreto() {
    return process.env.JWT_SECRET || 'crm-andino-secreto-de-desarrollo';
}

function generarToken(usuario) {
    return jwt.sign(
        { id: usuario.id, nombre: usuario.nombre, rol: usuario.rol },
        secreto(),
        { expiresIn: '30d' }
    );
}

// Verifica el token. Si es válido, deja los datos del usuario en req.usuario.
function requiereSesion(req, res, next) {
    const cabecera = req.get('Authorization') || '';
    const token = cabecera.startsWith('Bearer ') ? cabecera.slice(7) : null;
    if (!token) {
        return res.status(401).json({ error: 'SIN_SESION', mensaje: 'Debes iniciar sesión.' });
    }
    try {
        req.usuario = jwt.verify(token, secreto());
        next();
    } catch (e) {
        return res.status(401).json({ error: 'SESION_INVALIDA', mensaje: 'La sesión expiró. Vuelve a iniciar sesión.' });
    }
}

// Permisos por rol: solo deja pasar a los roles indicados.
function permitirRoles(...roles) {
    return (req, res, next) => {
        if (!roles.includes(req.usuario.rol)) {
            return res.status(403).json({
                error: 'SIN_PERMISO',
                mensaje: 'Tu rol no tiene permiso para realizar esta operación.'
            });
        }
        next();
    };
}

module.exports = { generarToken, requiereSesion, permitirRoles };
