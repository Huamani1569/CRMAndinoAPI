# CRM Andino Perú — API REST 🌐

API REST compartida por las apps **CRM Andino Vendedor** y **CRM Andino Supervisor** (Evaluación Parcial – Semana 8).
Node.js · Express · PostgreSQL (Neon) · JWT · bcrypt.

```
App Vendedor  ┐
              ├──► API REST (esta carpeta) ──► PostgreSQL en Neon (base remota)
App Supervisor┘
```
Las apps **nunca** se conectan directo a la base de datos: todo pasa por esta API.

## Puesta en marcha
1. Instalar **Node.js LTS** (https://nodejs.org) → verificar con `node -v`.
2. Copiar `.env.example` como `.env` y pegar en `DATABASE_URL` el *connection string* de Neon.
3. Instalar dependencias: `npm install`
4. Crear tablas y datos de prueba en Neon: `npm run init-db` *(borra y recarga los datos de demo)*
5. Iniciar la API: `npm start` → abre http://localhost:3000/api/salud

Desde el **emulador** de Android la API se llama `http://10.0.2.2:3000/`.

## Cuentas de prueba
| Rol | Correo | Contraseña | App |
|---|---|---|---|
| Vendedor (`cliente`) | carlos@crmandino.pe | vendedor123 | Vendedor (30 leads) |
| Vendedor (`cliente`) | lucia@crmandino.pe | vendedor123 | Vendedor |
| Supervisor (`administrador`) | supervisor@crmandino.pe | super123 | Supervisor |

## Endpoints
| Método | Ruta | Vendedor | Supervisor |
|---|---|---|---|
| POST | `/api/auth/login` | ✔ | ✔ |
| GET | `/api/leads` · `/api/leads/{id}` | solo sus leads | todos |
| POST | `/api/leads` | ✔ (lead propio) | ✖ 403 |
| PUT | `/api/leads/{id}` | sus leads, sin reasignar | editar y **reasignar** |
| DELETE | `/api/leads/{id}` | ✖ 403 | ✔ (borrado lógico) |
| GET | `/api/interacciones` · `/{id}` | de sus leads | todas (consulta) |
| POST/PUT/DELETE | `/api/interacciones[/{id}]` | ✔ | ✖ 403 |
| GET | `/api/tareas` · `/{id}` | de sus leads | todas (RF07) |
| POST/PUT/DELETE | `/api/tareas[/{id}]` | ✔ | ✖ 403 |
| GET | `/api/usuarios/vendedores` | ✖ | ✔ |
| GET | `/api/salud` | público | público |
| GET | `/api/dev/estado` · `/api/dev/falla?activar=1\|0` | demo | demo |

## Sincronización segura
- **Sin duplicados:** cada escritura trae la cabecera `X-Operacion-UUID`. Si llega dos veces, el servidor devuelve la respuesta guardada en `operaciones_procesadas` y **no** vuelve a ejecutarla (`"duplicada": true`). Además cada registro tiene su propio `uuid` único.
- **Conflictos:** cada registro tiene `version`. El `PUT`/`DELETE` envía la versión que conocía la app; si en el servidor ya cambió → **409 `CONFLICTO_VERSION`** con la versión actual (`actual`). También: **409 `REASIGNADO`** (el lead ya es de otro vendedor) y **409 `ELIMINADO`**.
- **Permisos y validaciones en el servidor:** rol por endpoint (403), empresa obligatoria, valor ≥ 0, etapa y fechas válidas (422).
- **Falla simulada:** `GET /api/dev/falla?activar=1` hace que la API responda 503 (para probar que la app no pierde datos).

## Archivos
```
db/schema.sql        tablas de la base remota
db/seed.sql          datos de prueba (48 leads, 16 tareas, 12 interacciones, 5 usuarios)
scripts/init-db.js   ejecuta schema + seed en Neon
src/server.js        inicio del servidor
src/app.js           rutas y middlewares
src/operaciones.js   idempotencia (X-Operacion-UUID)
src/middleware/      auth (JWT, roles) y falla simulada
src/routes/          auth, leads, interacciones, tareas, usuarios, dev
```
