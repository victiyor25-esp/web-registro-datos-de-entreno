# Diario de Entrenos — puesta en marcha

Archivos: `index.html`, `style.css`, `app.js`, `firestore.rules`.

Lo que ya está hecho en el código: login (Google + correo), datos separados por
usuario, récords, rachas, zonas de FC, gráficas, importación de `.gpx`/`.tcx`,
migración de tus datos antiguos, exportar y borrar.

Quedan cuatro cosas que solo puedes hacer tú, desde la consola de Firebase.
Son cinco minutos.

---

## 1. Activar los métodos de acceso

Consola de Firebase → tu proyecto `app-web-runn` → **Authentication** → *Get started*
→ pestaña **Sign-in method**:

- Activa **Google**.
- Activa **Correo electrónico/contraseña**.

Sin esto, el login da el error «ese método de acceso no está activado».

## 2. Publicar las reglas de seguridad

**Firestore Database** → pestaña **Reglas** → pega el contenido de
`firestore.rules` → **Publicar**.

Esto es lo que impide que un desconocido lea o borre tus entrenos. Hazlo aunque
no hagas nada más.

## 3. Subir la web

La app necesita servirse por HTTPS: abriendo `index.html` con doble clic
(`file://`) el login de Google no funciona.

Con Firebase Hosting, desde la carpeta del proyecto:

```
npm install -g firebase-tools
firebase login
firebase init hosting      # carpeta pública: la que contiene index.html; SPA: no
firebase deploy
```

Te dará una URL `https://app-web-runn.web.app`. Añádela en
**Authentication → Settings → Dominios autorizados** si no aparece sola.

*(Alternativa sin consola: subir los tres archivos a Netlify arrastrando la
carpeta. Entonces añade el dominio de Netlify a los dominios autorizados.)*

## 4. Recuperar tus datos antiguos

Entra con tu cuenta y ve a **Cuenta**. Si había entrenos guardados sin usuario,
aparece el botón **«Traer mis datos antiguos»**: púlsalo una vez. Cuando
compruebes que están todos, borra el último bloque de `firestore.rules` (el de
las colecciones antiguas) y vuelve a publicar las reglas.

---

## Cosas que conviene saber

**Récords.** Se calculan de tus entrenos. Si el entreno fue de la distancia
justa (±2%), el récord es exacto. Si fue más largo, se estima con tu ritmo medio
y se marca como *Estimado* — siempre será algo peor que tu récord real, porque
un 10 km dentro de un fondo de 15 km lo corriste más suave. Para los récords de
verdad, usa **«Añadir a mano»**.

**Zonas de FC.** Necesitan tu FC máxima (o tu edad, y se estima con 220 − edad)
en el perfil, y la FC media de cada entreno. Se atribuye toda la duración del
entreno a la zona de su FC media: es una aproximación honesta, no el reparto
segundo a segundo del reloj. Para eso hace falta importar el archivo.

**Importar.** `.gpx` y `.tcx` funcionan ya, sin servidor: se rellena el
formulario y tú revisas antes de guardar. El `.fit` es binario y no se lee en el
navegador; exporta como `.gpx` desde Garmin o Strava.

**Strava automático.** Necesita un servidor pequeño (una Cloud Function) porque
la clave secreta de Strava no puede ir en el JS del navegador. El botón está
puesto y desactivado. Si algún día lo quieres, dímelo.

**La `apiKey` del código es pública por diseño** y no es un problema: quien
protege los datos son las reglas del paso 2.
