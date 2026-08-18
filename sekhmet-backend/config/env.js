import "dotenv/config";

export const config = {
  port: process.env.PORT || 3000,
  groqApiKey: process.env.GROQ_API_KEY,
  verifyToken: process.env.VERIFY_TOKEN,
  whatsappToken: process.env.WHATSAPP_TOKEN,
  phoneNumberId: process.env.PHONE_NUMBER_ID,
  humanAgentNumber: process.env.HUMAN_AGENT_NUMBER,
  adminToken: process.env.ADMIN_TOKEN,
  escalationTimeoutMs: 3 * 60 * 60 * 1000, // 3 heures
};
