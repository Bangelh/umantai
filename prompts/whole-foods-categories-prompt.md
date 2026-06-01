# Prompt: Umantai Whole Foods Categories System

You are an expert full-stack developer working on Umantai.com, a premium marketplace for Whole Foods and Technology.

## Task
Create a clean, scalable, and type-safe category system for the "Whole Foods" section of the Umantai product catalog, focused on **Frutas y Verduras** (Fruits and Vegetables).

Use the following exact hierarchical structure provided by the client (Peruvian market style):

### Frutas
- Naranja, Mandarina y Otros Cítricos
- Manzana, Pera y Membrillo
- Papaya y Piña
- Paltas
- Plátano y Uva
- Fresa, Arándano, Aguaymanto y Otros Berries
- Melocotón, Durazno y Mango
- Maracuyá, Granadilla, Tuna y Tumbo
- Sandía y Melón
- Chirimoya, Lúcuma, Carambola y Otras
- Frutas Picadas y Preparadas
- Jugos Naturales
- Frutas Congeladas

### Verduras
- Papa, Camote, Yuca y Otros Tubérculos
- Lechuga, Espinaca y Hojas Verdes
- Cebolla, Ajo, Rocoto y Ají
- Hongos, Setas y Germinados
- Tomate, Pepino y Pimiento
- Limón
- Zapallo, Berenjena y Caigua
- Zanahoria, Beterraga, Rabanito y Otras Raíces
- Brócoli, Coliflor, Alcachofa y Col
- Apio, Espárrago y Otros Tallos
- Choclo
- Arveja, Vainita, Haba y Otras Legumbres
- Hierbas e Infusiones
- Verduras Orientales
- Ensaladas y Verduras Picadas
- Verduras Congeladas

## Requirements

1. **TypeScript Types**
   - Create a proper hierarchical `Category` interface that supports parent-child relationships.
   - Support both top-level categories and deep subcategories.
   - Include optional fields like `slug`, `icon`, `description`, and `image`.

2. **Data Structure**
   - Implement the full category tree shown above as a TypeScript constant.
   - Make it easy to filter products by main category or any level of subcategory.

3. **Integration**
   - Update the existing `Product` interface (currently has `category: string`) to support a more flexible system (e.g., `category` + `subcategory`, or a `categoryPath: string[]`).
   - Provide helper functions such as:
     - `getAllSubcategories()`
     - `getCategoryBySlug(slug)`
     - `getProductsByCategory(categoryId)`
     - `getCategoryBreadcrumb(categoryId)`

4. **UI Recommendations (for future implementation)**
   - Suggest how to display this hierarchy in the products page (sidebar filters, mega menu, or pills).
   - Recommend a good UX pattern for mobile vs desktop.
   - Suggest how to show "Whole Foods → Frutas → Berries" style breadcrumbs.

5. **Best Practices**
   - Keep the structure maintainable and easy to extend (we will add more top-level categories like "Granos y Legumbres", "Lácteos", "Proteínas", etc. later).
   - Use slugs that are URL-friendly and stable.

## Output Format
- Provide the full TypeScript code.
- Include the complete `wholeFoodsCategories` data structure using the exact Spanish names provided.
- Include example usage.
- Add comments in Spanish where it makes sense for the client.

Generate production-ready, clean, and well-typed code following modern Next.js + TypeScript conventions.
