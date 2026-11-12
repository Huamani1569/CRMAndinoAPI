// Verificación del ID token de "Iniciar sesión con Google" (API externa de Google Identity).
// La app obtiene el token con Credential Manager y la API lo valida con el endpoint oficial tokeninfo:
// firma vigente, emisor de Google, audiencia = nuestro ID de cliente web y correo verificado.
const { ErrorHttp } = require('./errores');

// ID de cliente web de Google (público, no es un secreto). Se puede cambiar con GOOGLE_CLIENT_IDS en .env
const CLIENTES = (process.env.GOOGLE_CLIENT_IDS || '246356629954-dsjaqc5bmg897sht81he1nbhvu0i0sjt.apps.googleusercontent.com')
    .split(',').map(s => s.trim()).filter(Boolean);

async function verificarTokenGoogle(idToken) {
    const token = String(idToken || '');
    if (!token) throw new ErrorHttp(400, 'TOKEN_GOOGLE_REQUERIDO', 'Falta el token de Google.');
    // Solo para las pruebas automáticas (nunca se activa en la demo): "prueba:<correo>:<nombre>"
    if (process.env.GOOGLE_TOKENS_DE_PRUEBA === '1' && token.startsWith('prueba:')) {
        const [, correo, nombre] = token.split(':');
        return { sub: 'prueba-' + correo, correo: correo.toLowerCase(), nombre: nombre || correo };
    }
    let datos;
    try {
        const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token));
        datos = await r.json();
        if (!r.ok) throw new Error(datos.error_description || 'token inválido');
    } catch (e) {
        throw new ErrorHttp(401, 'TOKEN_GOOGLE_INVALIDO', 'No se pudo verificar tu cuenta de Google. Inténtalo de nuevo.');
    }
    if (!['accounts.google.com', 'https://accounts.google.com'].includes(datos.iss) || !CLIENTES.includes(datos.aud)) {
        throw new ErrorHttp(401, 'TOKEN_GOOGLE_INVALIDO', 'El token de Google no es para esta aplicación.');
    }
    if (String(datos.email_verified) !== 'true') {
        throw new ErrorHttp(401, 'CORREO_NO_VERIFICADO', 'Tu correo de Google no está verificado.');
    }
    return { sub: datos.sub, correo: String(datos.email).toLowerCase(), nombre: datos.name || datos.email };
}

module.exports = { verificarTokenGoogle };
