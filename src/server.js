// Punto de entrada: npm start
require('dotenv').config();
const os = require('os');
const { crearApp } = require('./app');
const { query } = require('./db');

const PUERTO = Number(process.env.PORT) || 3000;

async function iniciar() {
    try {
        await query('SELECT 1');
        console.log('✔ Conectado a la base de datos remota (Neon).');
    } catch (error) {
        console.error('✖ No se pudo conectar a la base de datos. Revisa DATABASE_URL en el archivo .env');
        console.error('  Detalle:', error.message);
    }

    // 0.0.0.0 → acepta conexiones del emulador y de celulares en la misma red Wi-Fi.
    crearApp().listen(PUERTO, '0.0.0.0', () => {
        console.log(`\n🚀 API CRM Andino escuchando en el puerto ${PUERTO}`);
        console.log(`   En esta laptop:        http://localhost:${PUERTO}/api/salud`);
        console.log(`   Desde el EMULADOR:     http://10.0.2.2:${PUERTO}/`);
        for (const lista of Object.values(os.networkInterfaces())) {
            for (const red of lista || []) {
                if (red.family === 'IPv4' && !red.internal) {
                    console.log(`   Desde un CELULAR (Wi-Fi): http://${red.address}:${PUERTO}/`);
                }
            }
        }
        console.log('\nCada petición que llegue se mostrará aquí abajo:\n');
    });
}

iniciar();
