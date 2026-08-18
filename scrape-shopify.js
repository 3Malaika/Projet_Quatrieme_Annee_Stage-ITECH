// scrape-shopify.js
// Récupère tous les produits d'une boutique Shopify via son API JSON publique
// et génère un fichier au format attendu par catalogue.json

import fs from "fs";

const SHOP_URL = "https://sekhmet-shop.com";

async function fetchAllProducts() {
  let allProducts = [];
  let page = 1;

  while (true) {
    const url = `${SHOP_URL}/products.json?limit=250&page=${page}`;
    console.log(`Récupération page ${page}...`);

    const response = await fetch(url);
    if (!response.ok) {
      console.error(`Erreur HTTP ${response.status} sur la page ${page}`);
      break;
    }

    const data = await response.json();
    const products = data.products;

    if (!products || products.length === 0) {
      break; // plus de produits, on arrête la pagination
    }

    allProducts = allProducts.concat(products);
    page++;

    // Pause polie entre les requêtes pour ne pas surcharger le serveur
    await new Promise((r) => setTimeout(r, 500));
  }

  return allProducts;
}

function convertToCatalogueFormat(shopifyProducts) {
  const catalogue = [];
  let id = 1;

  for (const product of shopifyProducts) {
    // Un produit Shopify peut avoir plusieurs "variantes" (tailles, formats, poids...)
    // On crée une entrée de catalogue par variante, comme pour le miel 0,5L / 1L par exemple.
    for (const variant of product.variants) {
      catalogue.push({
        id: String(id++),
        nom: variant.title !== "Default Title" ? `${product.title} (${variant.title})` : product.title,
        unite: variant.title !== "Default Title" ? variant.title : "",
        prix: `${variant.price} FCFA`,
        stock: variant.available ? "disponible" : "rupture de stock",
      });
    }
  }

  return catalogue;
}

async function main() {
  const products = await fetchAllProducts();
  console.log(`${products.length} produits Shopify récupérés.`);

  const catalogue = convertToCatalogueFormat(products);
  console.log(`${catalogue.length} entrées de catalogue générées.`);

  fs.writeFileSync("catalogue-shopify.json", JSON.stringify(catalogue, null, 2));
  console.log("Fichier catalogue-shopify.json créé avec succès.");
}

main().catch((err) => console.error("Erreur:", err.message));
