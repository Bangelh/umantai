# Logo UMANTAI — slot del asset definitivo

El cliente entregará el logo oficial. **No hay un logo inventado en este repo.**

Para publicarlo:

1. Copia el archivo definitivo como `public/brand/umantai-logo.svg`.
2. Recarga el sitio: `components/brand/BrandLogo.tsx` detecta el archivo y lo usa
   automáticamente (header y home).
3. Si además hay versión clara/oscura, guárdalas como
   `umantai-logo-dark.svg` / `umantai-logo-light.svg` y luego se selecciona por
   tema; por ahora el SVG debe funcionar sobre fondo oscuro.

Requisitos del SVG:

- Preferir `currentColor` para heredar el color de texto.
- Área visible sin padding excesivo (el componente controla la altura).
- No incluir texto alternativo dentro del SVG; el `alt` lo pone el componente.

Mientras el archivo no exista, `BrandLogo` muestra el wordmark tipográfico
`umantai`, que ya era la marca visible de la app.
