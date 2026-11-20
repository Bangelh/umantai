# Leyes de UI/UX de UMANTAI

Reglas permanentes para cualquier pantalla del comprador, del comercio y del admin.
Antes de cerrar un cambio visual, recorrerlas en orden y anotar cuál se aplicó.

## 1. Ley de Hick — menos opciones, antes

Cuantas más opciones hay, más tarda la persona en decidir. Las decisiones se
revelan en el momento en que hacen falta, no todas juntas.

- La búsqueda es la acción dominante; el resto es secundario.
- Filtros y orden aparecen solo cuando aportan: el orden por cercanía se
  habilita con ubicación, y las opciones de radio solo existen con ubicación
  elegida.
- Los estados vacíos ofrecen **una** salida clara (limpiar búsqueda o limpiar
  ubicación), no un menú de alternativas.
- Nunca dos acciones primarias compitiendo en la misma pantalla.

## 2. Ley de Fitts — lo importante, grande y cerca

El tiempo de acierto depende del tamaño del objetivo y de su distancia.

- Objetivos táctiles de 44 px como mínimo (`min-h-11`/`min-h-14` en CTAs).
- La acción principal vive junto al dato que la motiva: agregar al carrito al
  lado del precio, no al final de la página.
- El buscador y su botón comparten bloque y altura; no se separan en móvil.
- En formularios, el campo y su acción quedan contiguos.

## 3. Ley de Jakob — respetar lo que la gente ya sabe

Las personas esperan que la interfaz se comporte como las que ya usan.

- Navegación, carrito, checkout y filtros siguen el patrón de comercio
  electrónico conocido: carrito arriba a la derecha, barra inferior en móvil,
  "agregar" junto al producto.
- Los controles usan el vocabulario del comprador ("Agregar", "Ver carrito"),
  no el del sistema ("mutar", "commit").
- Los enlaces se ven como enlaces y los botones como botones; nada de apariencia
  engañosa.

## 4. Ley de Proximidad — lo relacionado, junto

Los elementos cercanos se leen como un grupo. El espacio es información.

- Precio, stock y distancia forman un solo bloque de decisión.
- La tienda y el producto se agrupan en la fila; el comercio nunca queda como
  texto suelto al final.
- Un cambio de sección se marca con borde y aire, no con un rótulo extra.
- Separar lo que no se relaciona evita que el usuario agrupe mal.

## 5. Ley de Tesler — conservar el esfuerzo del usuario

Cada paso que el sistema puede resolver, no lo hace la persona.

- La primera pintura ya trae productos y tiendas: nadie espera un segundo
  request para ver algo.
- La búsqueda se debouncea y se cancela la petición anterior; no se pide
  "buscar" dos veces.
- La ubicación se restaura en la misma pestaña y solo se pide con un clic
  explícito.
- Los mensajes de error dicen qué pasó y cuál es el siguiente paso.
- Los estados de carga muestran la forma del contenido (skeleton), no un
  spinner vacío.

## Cómo se traduce al código

- Tokens de `app/globals.css`: `surface-card`, `btn-primary`, `btn-secondary`,
  `field-input`, escala `text-body`/`text-title`/`text-display`.
- Movimiento: `components/ui/Reveal.tsx` (entrada en viewport) y
  `components/ui/SpotlightSurface.tsx` (luz que sigue al puntero). Ambos
  respetan `prefers-reduced-motion` y solo animan `transform`/`opacity`.
- Fondo: `components/ui/AuroraBackdrop.tsx`, SVG generado al estilo Haikei
  (blobs difusos + retícula). Sin imágenes externas ni peso de red.
- Contraste mínimo AA (4.5:1 en texto normal) en ambos temas, foco visible y
  objetivos táctiles de 44 px.
