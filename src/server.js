// Punto de entrada: npm start
require('dotenv').config();
const os = require('os');
const { crearApp } = require('./app');
const { query } = require('./db');
const { aplicarMigraciones } = require('./migraciones');
const { entrenarTodo } = require('./ml');
const { vencerCotizaciones } = require('./routes/cotizaciones');

const PUERTO = Number(process.env.PORT) || 3000;

async function iniciar() {
    try {
        await query('SELECT 1');
        console.log('✔ Conectado a la base de datos remota (Neon).');
        // Proyecto Final: la base se actualiza sola (migraciones pendientes) y se entrenan los modelos de ML
        const aplicadas = await aplicarMigraciones();
        console.log(aplicadas.length ? `✔ Base actualizada (${aplicadas.length} migración(es)).` : '✔ Base de datos al día.');
        const modelos = await query('SELECT count(*)::int AS n FROM modelos_ml');
        if (aplicadas.length || modelos.rows[0].n < 4) {
            const r = await entrenarTodo();
            console.log(`✔ Modelos de ML entrenados: lead scoring AUC ${r.leadScoring.auc}, churn AUC ${r.churn.auc}, ${r.apriori.reglas} reglas de venta cruzada.`);
        }
        // Tareas programadas: vencer cotizaciones (RN-04), cerrar tickets resueltos hace 48 h y reentrenar cada noche
        setInterval(() => vencerCotizaciones().catch(e => console.error('vencer:', e.message)), 60 * 60 * 1000);
        setInterval(() => entrenarTodo().catch(e => console.error('ML:', e.message)), 24 * 60 * 60 * 1000);
    } catch (error) {
        console.error('✖ No se pudo preparar la base de datos. Revisa DATABASE_URL en el archivo .env');
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
