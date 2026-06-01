export interface Product {
  slug: string;
  name: string;
  brand: string;
  price: number;
  category: string;           // Main category (e.g. "Whole Foods", "Smartphones")
  subcategory?: string;       // Specific subcategory (e.g. "Fresa, Arándano, Aguaymanto y Otros Berries")
  description: string;
  specs: string[];
  inStock: number;
  rating: number;
  reviewCount: number;
  bestseller?: boolean;
  images: string[];
  colors?: string[];
  storage?: string[];
}

export const products: Product[] = [
  {
    slug: "iphone-15-pro-titanium",
    name: "iPhone 15 Pro",
    brand: "Apple",
    price: 999,
    category: "Smartphones",
    description: "Titanium design. A17 Pro chip. The most advanced iPhone ever. Pro camera system with 5x Telephoto.",
    specs: ["6.1\" Super Retina XDR", "A17 Pro Chip", "48MP Main Camera", "Up to 29 hours video"],
    inStock: 142,
    rating: 4.9,
    reviewCount: 2843,
    bestseller: true,
    images: ["/images/products/iphone-16-pro-titanium.jpg", "/images/products/peak-design-45l.jpg", "/images/products/anker-prime-powerbank.jpg"],
    colors: ["Natural Titanium", "Blue Titanium", "White Titanium", "Black Titanium"],
    storage: ["128GB", "256GB", "512GB", "1TB"],
  },
  {
    slug: "dyson-v15-detect",
    name: "Dyson V15 Detect Absolute",
    brand: "Dyson",
    price: 749,
    category: "Smart Home",
    description: "Laser dust detection. 60-minute runtime. The most intelligent cordless vacuum.",
    specs: ["Laser Dust Detection", "60 min runtime", "HEPA filtration", "LCD screen"],
    inStock: 64,
    rating: 4.8,
    reviewCount: 756,
    bestseller: true,
    images: ["/images/products/dyson-v15-detect.jpg", "/images/products/dyson-airwrap.jpg"],
  },
  {
    slug: "oura-ring-gen3",
    name: "Oura Ring Gen3",
    brand: "Oura",
    price: 299,
    category: "Wearables",
    description: "The most advanced health and wellness wearable. 24/7 heart rate, sleep tracking, readiness score, and recovery insights.",
    specs: ["Titanium construction", "7-day battery", "Sleep + Readiness scoring", "Waterproof"],
    inStock: 312,
    rating: 4.7,
    reviewCount: 1342,
    bestseller: true,
    images: ["/images/products/oura-ring-gen3-stealth.jpg", "/images/products/apple-watch-ultra-2.jpg"],
    colors: ["Stealth", "Silver", "Gold"],
  },
  {
    slug: "peak-design-travel-backpack-45l",
    name: "Travel Backpack 45L",
    brand: "Peak Design",
    price: 229,
    category: "Accessories",
    description: "The ultimate travel backpack. Designed for photographers and travelers who demand the best.",
    specs: ["45L capacity", "Weatherproof", "Camera cube compatible", "Laptop sleeve"],
    inStock: 89,
    rating: 4.9,
    reviewCount: 423,
    bestseller: true,
    images: ["/images/products/peak-design-45l.jpg"],
  },
  {
    slug: "bose-quietcomfort-ultra",
    name: "Bose QuietComfort Ultra Headphones",
    brand: "Bose",
    price: 429,
    category: "Wearables",
    description: "World-class noise cancelling headphones with premium sound and all-day comfort.",
    specs: ["Industry-leading ANC", "24-hour battery", "Premium materials", "Spatial audio"],
    inStock: 156,
    rating: 4.6,
    reviewCount: 892,
    bestseller: true,
    images: ["/images/products/bose-quietcomfort-ultra.jpg"],
  },
  {
    slug: "galaxy-s24-ultra",
    name: "Galaxy S24 Ultra",
    brand: "Samsung",
    price: 1299,
    category: "Smartphones",
    description: "The ultimate Android flagship with S Pen, 200MP camera, and titanium frame.",
    specs: ["6.8\" Dynamic AMOLED", "200MP Camera", "S Pen included", "Titanium frame"],
    inStock: 78,
    rating: 4.8,
    reviewCount: 1247,
    images: ["/images/products/galaxy-s24-ultra.jpg"],
    storage: ["256GB", "512GB", "1TB"],
  },
  {
    slug: "whoop-4-0",
    name: "Whoop 4.0",
    brand: "Whoop",
    price: 239,
    category: "Wearables",
    description: "Advanced fitness and recovery tracking worn on the wrist or bicep.",
    specs: ["Continuous HRV", "Sleep tracking", "Strain score", "30-day battery"],
    inStock: 203,
    rating: 4.5,
    reviewCount: 634,
    images: ["/images/products/whoop-4-0.jpg"],
  },
  {
    slug: "sonos-arc-ultra",
    name: "Sonos Arc Ultra",
    brand: "Sonos",
    price: 999,
    category: "Smart Home",
    description: "Premium Dolby Atmos soundbar for the ultimate home theater experience.",
    specs: ["Dolby Atmos", "14 drivers", "Voice control", "WiFi + Bluetooth"],
    inStock: 45,
    rating: 4.7,
    reviewCount: 312,
    images: ["/images/products/sonos-arc-ultra.jpg"],
  },
  {
    slug: "anker-737-power-bank",
    name: "Anker Prime 27,650mAh Power Bank",
    brand: "Anker",
    price: 129,
    category: "Accessories",
    description: "High-capacity portable charger with 140W output and smart display.",
    specs: ["27,650mAh", "140W output", "Smart digital display", "3 ports"],
    inStock: 167,
    rating: 4.8,
    reviewCount: 589,
    images: ["/images/products/anker-prime-powerbank.jpg"],
  },
  {
    slug: "blue-bottle-subscription",
    name: "Blue Bottle Coffee — Single Origin Subscription",
    brand: "Blue Bottle",
    price: 68,
    category: "Whole Foods",
    subcategory: "Jugos Naturales",
    description: "Monthly subscription of exceptional single-origin coffee, roasted to order.",
    specs: ["12oz bags", "Monthly delivery", "Rotating origins", "Carbon negative"],
    inStock: 999,
    rating: 4.9,
    reviewCount: 1243,
    images: ["/images/products/blue-bottle-subscription.jpg"],
  },
  {
    slug: "patagonia-provisions-salmon",
    name: "Patagonia Provisions Smoked Salmon",
    brand: "Patagonia",
    price: 34,
    category: "Whole Foods",
    subcategory: "Legumbres", // Temporary - ideally we'd have a "Proteínas" group
    description: "Wild-caught, regeneratively sourced smoked salmon from Alaska.",
    specs: ["6oz portions", "Regenerative", "Wild Alaskan", "No additives"],
    inStock: 234,
    rating: 4.8,
    reviewCount: 287,
    images: ["/images/products/patagonia-provisions-salmon.jpg"],
  },
  {
    slug: "amazon-fresh-whole-bean-ethiopia",
    name: "Amazon Fresh — Ethiopia Yirgacheffe Whole Bean",
    brand: "Amazon Foods",
    price: 18.99,
    category: "Whole Foods",
    subcategory: "Jugos Naturales",
    description: "Bright, floral single-origin coffee from the Yirgacheffe region.",
    specs: ["12oz bag", "Whole bean", "Medium roast", "Direct trade"],
    inStock: 412,
    rating: 4.4,
    reviewCount: 156,
    images: ["/images/products/amazon-fresh-whole-bean-ethiopia.jpg"],
  },
  {
    slug: "amazon-fresh-extra-virgin-olive-oil",
    name: "Amazon Fresh — Extra Virgin Olive Oil",
    brand: "Amazon Foods",
    price: 24.5,
    category: "Whole Foods",
    subcategory: "Aceites y Condimentos", // We'll expand this category later
    description: "Cold-pressed extra virgin olive oil from small farms in Tuscany.",
    specs: ["500ml bottle", "Cold pressed", "First harvest", "Protected designation"],
    inStock: 289,
    rating: 4.6,
    reviewCount: 203,
    images: ["/images/products/amazon-fresh-extra-virgin-olive-oil.jpg"],
  },
  {
    slug: "apple-watch-ultra-2",
    name: "Apple Watch Ultra 2",
    brand: "Apple",
    price: 799,
    category: "Wearables",
    description: "The most rugged and capable Apple Watch, built for endurance athletes.",
    specs: ["49mm titanium case", "36-hour battery", "Precision dual-frequency GPS", "Bright display"],
    inStock: 93,
    rating: 4.8,
    reviewCount: 987,
    images: ["/images/products/apple-watch-ultra-2.jpg"],
  },
  {
    slug: "galaxy-buds3-pro",
    name: "Galaxy Buds3 Pro",
    brand: "Samsung",
    price: 249,
    category: "Wearables",
    description: "Premium wireless earbuds with AI features and excellent sound.",
    specs: ["AI features", "ANC", "360 Audio", "IP57 water resistance"],
    inStock: 134,
    rating: 4.5,
    reviewCount: 412,
    images: ["/images/products/galaxy-buds3-pro.jpg"],
  },
  {
    slug: "google-pixel-8-pro",
    name: "Google Pixel 8 Pro",
    brand: "Google",
    price: 999,
    category: "Smartphones",
    description: "The ultimate Google phone with best-in-class AI and photography.",
    specs: ["6.8\" LTPO OLED", "50MP camera", "Tensor G3", "7 years of updates"],
    inStock: 67,
    rating: 4.7,
    reviewCount: 756,
    images: ["/images/products/google-pixel-8-pro.jpg"],
  },
];

export { mainCategories as categories } from "./categories";

export const brands = ["Apple", "Samsung", "Dyson", "Oura", "Bose", "Peak Design", "Google", "Anker", "Blue Bottle", "Patagonia", "Whoop", "Sonos"];

export function getProductBySlug(slug: string): Product | undefined {
  return products.find((p) => p.slug === slug);
}

export function getBestsellers(limit = 5): Product[] {
  return products.filter((p) => p.bestseller).slice(0, limit);
}
