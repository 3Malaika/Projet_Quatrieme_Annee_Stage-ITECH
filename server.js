import "dotenv/config";
import express from "express";
import Groq from "groq-sdk";


//------------  initialize express app ------------

// 1- Le serveur express est initialisé et configuré pour utiliser le middleware express.json() afin de pouvoir traiter les requêtes JSON entrantes.
const app = express();
app.use(express.json());

// 2- J'initialise une instance de Groq en utilisant la clé API stockée dans les variables d'environnement. Cette instance sera utilisée pour interagir avec l'API Groq.
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// 3- J'ajoutes les variables whatsapp

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;



//------------  On configure la memoire des conversations par numeros ------------
const conversations = {};

function getHistory(phoneNumber) {
  if (!conversations[phoneNumber]) {
    conversations[phoneNumber] = [
        {
          role: "system",
          content: "Tu es un assistant virtuel qui aide les utilisateurs à trouver des informations sur les produits et services de l'entreprise. Tu dois répondre de manière concise et polie.",
        },
    ];
  }
  return conversations[phoneNumber];
}

//------------  On configure l'envoi de messages WhatsApp ------------
async function sendWhatsappMessage(to, text) {
  const url = `https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`;

  await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: to,
      text: { body: text }
    })
  });
}

// -----------  On configure le webhook pour recevoir les messages WhatsApp ------------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified"); // pour les logs
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});


// -----------  On configure le webhook pour recevoir les messages WhatsApp ------------
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Répond immédiatement pour éviter les timeouts
  console.log("Received webhook:", JSON.stringify(req.body, null, 2)); // pour les logs
  
  //on initialise les variables du message
  const entry = req.body.entry?.[0];
  const change = entry?.changes?.[0];
  const message = change?.value?.messages?.[0];

  if(!message) return; // Si aucun message n'est présent, on quitte la fonction

  const from = message.from;
  const userMessaage = message.text?.body;

  if (!userMessaage) return; // Si le message n'est pas du texte, on quitte la fonction
  console.log(`Message de ${from}: ${userMessaage}`); // pour les logs

  try {
    const reply = await askGroq(from, userMessaage);
    await sendWhatsappMessage(from, reply);
  }catch (err) {
    console.error("Erreur:", err.message);
    await sendWhatsappMessage(from, "Désolé, une erreur est survenue. Veuillez réessayer plus tard.");
  }
});

// -----------  On configure le demarrage du serveur ------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});