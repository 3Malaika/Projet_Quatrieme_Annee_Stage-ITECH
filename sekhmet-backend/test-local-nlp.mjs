import { analyzeLocalMessage } from './services/localNlp.service.js';

const cases = [
  ['Bonjour 😊', 'greeting'],
  ['Coucou, je voulais juste vous saluer', 'greeting'],
  ['Bjr, je passe vous dire bonjour', 'greeting'],
  ['Merci beaucoup pour votre aide', 'thanks'],
  ['C’est gentil, merci pour toutes ces informations', 'thanks'],
  ['Je vous laisse, bonne journée', 'farewell'],
  ['Je dois y aller, à bientôt', 'farewell'],
  ['Vous avez encore ce produit ?', 'stock'],
  ['Il vous en reste encore ?', 'stock'],
  ['Cet article est-il toujours disponible ?', 'stock'],
  ['Combien coûte ce produit ?', 'price'],
  ['Vous le faites à quel tarif ?', 'price'],
  ['Quel montant dois-je prévoir ?', 'price'],
  ['Je voudrais commander celui-ci', 'order'],
  ['Je vais prendre celui-là', 'order'],
  ['Je souhaite passer commande', 'order'],
  ['Comment puis-je payer par Orange Money ?', 'paymentRequest'],
  ['Quels moyens de paiement acceptez-vous ?', 'paymentRequest'],
  ["J'ai déjà payé", 'paymentDone'],
  ['Voilà, je viens de faire le paiement', 'paymentDone'],
  ['Le règlement vient d’être effectué', 'paymentDone'],
  ['Où en est ma commande ?', 'tracking'],
  ['Quand vais-je recevoir mon colis ?', 'tracking'],
  ['ça arrive qd ?', 'tracking'],
  ['Je voudrais parler à une personne', 'human'],
  ['J’aimerais avoir quelqu’un au téléphone', 'human'],
  ['Je préfère parler directement à quelqu’un de votre équipe', 'human'],
  ['Je cherche quelque chose pour offrir à ma mère', 'productInfo'],
];

let ok = 0;
for (const [message, expected] of cases) {
  const a = await analyzeLocalMessage(message);
  const pass = a.intent === expected;
  if (pass) ok += 1;
  console.log(`${pass ? 'OK ' : 'ERR'} ${expected.padEnd(20)} -> ${a.intent.padEnd(20)} confidence=${a.confidence.toFixed(2)} groq=${a.requiresGroq ? 'YES' : 'NO'} | ${message}`);
}
console.log(`\n${ok}/${cases.length} intentions reconnues sur le jeu de test local.`);
if (ok < cases.length * 0.8) process.exitCode = 1;
