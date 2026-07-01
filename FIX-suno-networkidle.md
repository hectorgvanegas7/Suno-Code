# FIX: Suno verificación de sesión falla SIEMPRE con TimeoutError

## Síntoma
El pipeline falla en `=== Paso 2/4: verificando sesión de Suno ===` con:

```
[Paso 2/4] Suno no cargó bien, recargando página (intento 1/3)...
Orquestación falló: page.reload: Timeout 30000ms exceeded.
Call log:
  - waiting for navigation until "networkidle"
  - navigated to "https://suno.com/create"
name: 'TimeoutError'
```

Stack apunta a `start-flow.js:166:20` dentro de `withCdp` → `runFlow` → `runPoll`.

## Causa raíz
La verificación de sesión hace `page.reload()` (o `goto`) esperando el estado
`networkidle`. **Suno mantiene websockets y polling constantes** (streaming de
audio, queue de generación, balance de créditos), así que la red NUNCA llega a
estar "idle". El wait agota los 30000ms y tira TimeoutError cada vez.

`networkidle` está **deprecado oficialmente por Playwright** precisamente por
este motivo: no es confiable en SPAs con conexiones persistentes. Hay que dejar
de usarlo en TODO el proyecto.

## Fix requerido (en start-flow.js, alrededor de la línea 166)

1. **Reemplazar `networkidle` por `domcontentloaded`** en el `reload`/`goto` de
   la verificación de sesión de Suno.
2. **No depender de la navegación para confirmar login.** Después del
   `domcontentloaded`, esperar un selector concreto que solo aparece cuando la
   sesión está activa (ej: el textarea de letra de Custom, el botón Create, o el
   widget de créditos). Esa señal del DOM es lo que confirma que Suno cargó, NO
   el estado de la red.
3. **Subir el timeout del reload** a 60000ms como margen, pero la espera real
   debe ser por el selector, no por la navegación.

### Patrón objetivo

```js
// ANTES (roto):
await page.reload({ waitUntil: 'networkidle', timeout: 30000 });

// DESPUÉS:
await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });

// Confirmar sesión por señal concreta del DOM, no por networkidle:
const SESSION_OK_SELECTOR = '<selector real del editor Custom / botón Create>';
try {
  await page.waitForSelector(SESSION_OK_SELECTOR, { timeout: 20000 });
  // sesión OK
} catch {
  // acá sí: no logueado o página rota → recargar / pedir login manual
}
```

## Acciones extra
- **Buscar y eliminar TODA otra aparición de `networkidle`** en el repo
  (`grep -rn networkidle .`) — en run.js, suno-fill.js, lib/*, donde sea — y
  reemplazar por `domcontentloaded` + espera de selector concreto. Es la misma
  trampa en cada lugar.
- Confirmar el selector real del editor Custom de Suno inspeccionando el DOM
  actual antes de hardcodearlo (Suno cambia clases; usar un atributo estable o
  texto del botón "Create", placeholder del textarea de letra, etc.).
- Mantener el loop de 3 intentos, pero ahora cada intento espera el selector,
  no la red.

## Criterio de aceptación
- `node start-flow.js` pasa el Paso 2/4 sin TimeoutError de forma consistente.
- No queda ninguna referencia a `networkidle` en el proyecto.
- Si Suno NO está logueado, el script lo detecta por ausencia del selector y
  avisa para login manual, en vez de morir con un TimeoutError genérico.
