export interface Category {
  id: string;
  name: string;
  subcategories?: Category[];
}

export const wholeFoodsCategories: Category = {
  id: "whole-foods",
  name: "Whole Foods",
  subcategories: [
    {
      id: "frutas",
      name: "Frutas",
      subcategories: [
        { id: "citricos", name: "Naranja, Mandarina y Otros Cítricos" },
        { id: "manzana-pera", name: "Manzana, Pera y Membrillo" },
        { id: "papaya-pina", name: "Papaya y Piña" },
        { id: "paltas", name: "Paltas" },
        { id: "platano-uva", name: "Plátano y Uva" },
        { id: "berries", name: "Fresa, Arándano, Aguaymanto y Otros Berries" },
        { id: "melocoton-durazno", name: "Melocotón, Durazno y Mango" },
        { id: "maracuya", name: "Maracuyá, Granadilla, Tuna y Tumbo" },
        { id: "sandia-melon", name: "Sandía y Melón" },
        { id: "chirimoya", name: "Chirimoya, Lúcuma, Carambola y Otras" },
        { id: "frutas-picadas", name: "Frutas Picadas y Preparadas" },
        { id: "jugos-naturales", name: "Jugos Naturales" },
        { id: "frutas-congeladas", name: "Frutas Congeladas" },
      ],
    },
    {
      id: "verduras",
      name: "Verduras",
      subcategories: [
        { id: "tuberculos", name: "Papa, Camote, Yuca y Otros Tubérculos" },
        { id: "hojas-verdes", name: "Lechuga, Espinaca y Hojas Verdes" },
        { id: "cebolla-aji", name: "Cebolla, Ajo, Rocoto y Ají" },
        { id: "hongos", name: "Hongos, Setas y Germinados" },
        { id: "tomate-pepino", name: "Tomate, Pepino y Pimiento" },
        { id: "limon", name: "Limón" },
        { id: "zapallo", name: "Zapallo, Berenjena y Caigua" },
        { id: "raices", name: "Zanahoria, Beterraga, Rabanito y Otras Raíces" },
        { id: "brocoli", name: "Brócoli, Coliflor, Alcachofa y Col" },
        { id: "apio", name: "Apio, Espárrago y Otros Tallos" },
        { id: "choclo", name: "Choclo" },
        { id: "legumbres", name: "Arveja, Vainita, Haba y Otras Legumbres" },
        { id: "hierbas", name: "Hierbas e Infusiones" },
        { id: "orientales", name: "Verduras Orientales" },
        { id: "ensaladas-picadas", name: "Ensaladas y Verduras Picadas" },
        { id: "verduras-congeladas", name: "Verduras Congeladas" },
      ],
    },
  ],
};

// Flat list for backward compatibility with current UI
export const flatWholeFoodsSubcategories = wholeFoodsCategories.subcategories!
  .flatMap(group => group.subcategories || [])
  .map(sub => sub.name);

// All top-level categories (extend this later)
export const mainCategories = ["Whole Foods", "Amazon Foods", "Smartphones", "Smart Home", "Wearables", "Accessories"];

// Helper to get all subcategories for a main category
export function getSubcategoriesForMainCategory(mainCategory: string): string[] {
  if (mainCategory === "Whole Foods") {
    return flatWholeFoodsSubcategories;
  }
  return [];
}
