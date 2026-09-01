import { analyzeLocalMessage } from './services/localNlp.service.js';

const cases = [
  ['Bonjour 😊', 'greeting'],
  ['Coucou, je voulais juste vous saluer', 'greeting'],
  ['Merci beaucoup pour votre aide', 'thanks'],
  ['Je vous laisse, bonne journée', 'farewell'],
  ['Vous avez encore ce produit ?', 'stock'],
  ['Combien coûte ce produit ?', 'price'],
  ['Je voudrais commander celui-ci', 'order'],
  ['Comment puis-je payer par Orange Money ?', 'paymentRequest'],
  ["J'ai déjà payé", 'paymentDone'],
  ['Où en est ma commande ?', 'tracking'],
  ['Je voudrais parler à une personne', 'human'],
  ['Bjr 😊', 'greeting'],
  ['Merci, vous êtes adorables', 'thanks'],
  ['Je dois y aller, à bientôt', 'farewell'],
  ['C est combien ?', 'price'],
  ['Il vous en reste encore ?', 'stock'],
  ['Je prends celui-là', 'order'],
];

let ok = 0;
for (const [message, expected] of cases) {
  const a = await analyzeLocalMessage(message);
  const pass = a.intent === expected;
  if (pass) ok += 1;
  console.log(`${pass ? 'OK ' : 'ERR'} ${expected.padEnd(20)} -> ${a.intent.padEnd(20)} confidence=${a.confidence.toFixed(2)} | ${message}`);
}
console.log(`\\n${ok}/${cases.length} intentions reconnues sur le jeu de test local.`);
if (ok < cases.length * 0.8) process.exitCode = 1;
